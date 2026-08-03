"""Optional off-machine storage for dataset audio: S3 or Supabase Storage.

    open_store("s3://my-bucket/saraga")
    open_store("supabase://datasets/saraga")

Dependency-free — SigV4 is signed by hand rather than pulling in boto3, so
these run on a stock Python with no install step.

Worth being clear about when this is actually needed, because mostly it is not.
Evaluation reads a one-minute excerpt from each recording and keeps only the
pitch track, which is about 100 kB per minute. The audio is scratch. Pushing it
to object storage pays off in exactly two cases:

  * re-tracking later with different YIN settings, without re-fetching from
    Zenodo or waiting on a VPN;
  * a machine too small to hold even the working set.

For everything else, fetch, track, delete.

Credentials come from the usual places: ~/.aws/credentials and ~/.aws/config
for S3, and SUPABASE_URL plus SUPABASE_SERVICE_KEY (or SUPABASE_KEY) for
Supabase. Nothing is read from the app's shipped publishable key -- that one is
read-only by design and cannot write to storage.
"""

import configparser
import datetime
import hashlib
import hmac
import os
import urllib.error
import urllib.parse
import urllib.request


class StoreError(Exception):
    pass


def open_store(url):
    scheme, _, rest = url.partition("://")
    if not rest:
        raise StoreError(f"malformed store URL: {url}")
    bucket, _, prefix = rest.partition("/")
    if scheme == "s3":
        return S3Store(bucket, prefix)
    if scheme == "supabase":
        return SupabaseStore(bucket, prefix)
    raise StoreError(f"unsupported store scheme '{scheme}' (use s3:// or supabase://)")


# ---------------------------------------------------------------- S3
class S3Store:
    def __init__(self, bucket, prefix="", profile=None):
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.key, self.secret, self.token, self.region = _aws_credentials(profile)
        if not self.key:
            raise StoreError(
                "no AWS credentials found — set AWS_ACCESS_KEY_ID / "
                "AWS_SECRET_ACCESS_KEY or populate ~/.aws/credentials"
            )
        self.host = f"{bucket}.s3.{self.region}.amazonaws.com"

    def _path(self, name):
        return f"{self.prefix}/{name}" if self.prefix else name

    def put(self, name, data):
        return self._request("PUT", self._path(name), data)

    def get(self, name):
        return self._request("GET", self._path(name), b"")

    def _request(self, method, key, payload):
        # Each path segment is escaped separately: S3 keys keep their slashes.
        canonical_uri = "/" + "/".join(
            urllib.parse.quote(seg, safe="") for seg in key.split("/"))
        url = f"https://{self.host}{canonical_uri}"

        now = datetime.datetime.now(datetime.timezone.utc)
        amzdate = now.strftime("%Y%m%dT%H%M%SZ")
        datestamp = now.strftime("%Y%m%d")
        payload_hash = hashlib.sha256(payload).hexdigest()

        headers = {
            "host": self.host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amzdate,
        }
        if self.token:
            headers["x-amz-security-token"] = self.token

        signed = ";".join(sorted(headers))
        canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
        canonical = "\n".join(
            [method, canonical_uri, "", canonical_headers, signed, payload_hash])

        scope = f"{datestamp}/{self.region}/s3/aws4_request"
        to_sign = "\n".join([
            "AWS4-HMAC-SHA256", amzdate, scope,
            hashlib.sha256(canonical.encode()).hexdigest()])
        signing_key = _sigv4_key(self.secret, datestamp, self.region, "s3")
        signature = hmac.new(signing_key, to_sign.encode(), hashlib.sha256).hexdigest()

        headers["Authorization"] = (
            f"AWS4-HMAC-SHA256 Credential={self.key}/{scope}, "
            f"SignedHeaders={signed}, Signature={signature}")

        req = urllib.request.Request(url, data=payload if method == "PUT" else None,
                                     headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            raise StoreError(f"S3 {method} {key} failed: {e.code} {e.read()[:200].decode('utf-8', 'replace')}")


def _sigv4_key(secret, datestamp, region, service):
    def sign(k, m):
        return hmac.new(k, m.encode(), hashlib.sha256).digest()
    k = sign(("AWS4" + secret).encode(), datestamp)
    k = sign(k, region)
    k = sign(k, service)
    return sign(k, "aws4_request")


def _aws_credentials(profile=None):
    profile = profile or os.environ.get("AWS_PROFILE", "default")
    key = os.environ.get("AWS_ACCESS_KEY_ID")
    secret = os.environ.get("AWS_SECRET_ACCESS_KEY")
    token = os.environ.get("AWS_SESSION_TOKEN")
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")

    if not key:
        cp = configparser.ConfigParser()
        cp.read(os.path.expanduser("~/.aws/credentials"))
        if cp.has_section(profile):
            key = cp.get(profile, "aws_access_key_id", fallback=None)
            secret = cp.get(profile, "aws_secret_access_key", fallback=None)
            token = cp.get(profile, "aws_session_token", fallback=None)
    if not region:
        cp = configparser.ConfigParser()
        cp.read(os.path.expanduser("~/.aws/config"))
        for sect in (profile, f"profile {profile}"):
            if cp.has_section(sect):
                region = cp.get(sect, "region", fallback=None)
                if region:
                    break
    return key, secret, token, region or "us-east-1"


# ---------------------------------------------------------------- Supabase
class SupabaseStore:
    def __init__(self, bucket, prefix=""):
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.base = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
        # Storage writes need a key that can write. The publishable key baked
        # into index.html is deliberately read-only, so it will not do here.
        self.key = (os.environ.get("SUPABASE_SERVICE_KEY")
                    or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
                    or os.environ.get("SUPABASE_KEY"))
        if not self.base or not self.key:
            raise StoreError(
                "set SUPABASE_URL and SUPABASE_SERVICE_KEY to use supabase:// storage "
                "(the publishable key in index.html is read-only and cannot write)"
            )

    def _url(self, name):
        key = f"{self.prefix}/{name}" if self.prefix else name
        quoted = "/".join(urllib.parse.quote(s, safe="") for s in key.split("/"))
        return f"{self.base}/storage/v1/object/{self.bucket}/{quoted}"

    def put(self, name, data):
        req = urllib.request.Request(
            self._url(name), data=data, method="POST",
            headers={
                "Authorization": f"Bearer {self.key}",
                "Content-Type": "application/octet-stream",
                "x-upsert": "true",
            })
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            raise StoreError(f"Supabase upload {name} failed: {e.code} "
                             f"{e.read()[:200].decode('utf-8', 'replace')}")

    def get(self, name):
        req = urllib.request.Request(
            self._url(name), headers={"Authorization": f"Bearer {self.key}"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            raise StoreError(f"Supabase download {name} failed: {e.code}")
