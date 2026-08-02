/* ============================================================
   SruthiScribe engine — pitch tracking + ragam-aware svara decoding
   Pure functions, no DOM. Testable in node.
   ============================================================ */
(function (root) {
  'use strict';

  // ---------- svarasthana model ----------
  // 12 positions per octave. Labels depend on ragam (R2 vs G1 etc.)
  var ET = [0,100,200,300,400,500,600,700,800,900,1000,1100];
  // Traditional just-intonation cents used in Carnatic praxis
  var JI = [0, 90, 204, 294, 386, 498, 590, 702, 792, 906, 996, 1088];

  function centsOf(pos, temperament) {
    return (temperament === 'ji' ? JI : ET)[pos];
  }

  // ---------- ragam database ----------
  // svaras: [position, label]. Positions are semitone offsets from Sa.
  function R(name, mela, aroh, avaroh, svaras) {
    return { name: name, mela: mela, aroh: aroh, avaroh: avaroh, svaras: svaras };
  }
  var S=0,R1=1,R2=2,R3=3,G3=4,M1=5,M2=6,P=7,D1=8,D2=9,D3=10,N3=11;

  var RAGAMS = [
    // --- melakarta ---
    R('Kanakangi',1,'S R1 G1 M1 P D1 N1 S','S N1 D1 P M1 G1 R1 S',[[0,'S'],[1,'R1'],[2,'G1'],[5,'M1'],[7,'P'],[8,'D1'],[9,'N1']]),
    R('Vakulabharanam',14,'S R1 G3 M1 P D1 N2 S','S N2 D1 P M1 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[5,'M1'],[7,'P'],[8,'D1'],[10,'N2']]),
    R('Mayamalavagowla',15,'S R1 G3 M1 P D1 N3 S','S N3 D1 P M1 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[5,'M1'],[7,'P'],[8,'D1'],[11,'N3']]),
    R('Chakravakam',16,'S R1 G3 M1 P D2 N2 S','S N2 D2 P M1 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Natabhairavi',20,'S R2 G2 M1 P D1 N2 S','S N2 D1 P M1 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[5,'M1'],[7,'P'],[8,'D1'],[10,'N2']]),
    R('Keeravani',21,'S R2 G2 M1 P D1 N3 S','S N3 D1 P M1 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[5,'M1'],[7,'P'],[8,'D1'],[11,'N3']]),
    R('Kharaharapriya',22,'S R2 G2 M1 P D2 N2 S','S N2 D2 P M1 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Gowrimanohari',23,'S R2 G2 M1 P D2 N3 S','S N3 D2 P M1 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[5,'M1'],[7,'P'],[9,'D2'],[11,'N3']]),
    R('Charukesi',26,'S R2 G3 M1 P D1 N2 S','S N2 D1 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[8,'D1'],[10,'N2']]),
    R('Harikambhoji',28,'S R2 G3 M1 P D2 N2 S','S N2 D2 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Shankarabharanam',29,'S R2 G3 M1 P D2 N3 S','S N3 D2 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[11,'N3']]),
    R('Hanumatodi',8,'S R1 G2 M1 P D1 N2 S','S N2 D1 P M1 G2 R1 S',[[0,'S'],[1,'R1'],[3,'G2'],[5,'M1'],[7,'P'],[8,'D1'],[10,'N2']]),
    R('Jhalavarali',39,'S R1 G1 M2 P D1 N3 S','S N3 D1 P M2 G1 R1 S',[[0,'S'],[1,'R1'],[2,'G1'],[6,'M2'],[7,'P'],[8,'D1'],[11,'N3']]),
    R('Subhapantuvarali',45,'S R1 G2 M2 P D1 N3 S','S N3 D1 P M2 G2 R1 S',[[0,'S'],[1,'R1'],[3,'G2'],[6,'M2'],[7,'P'],[8,'D1'],[11,'N3']]),
    R('Shanmukhapriya',56,'S R2 G2 M2 P D1 N2 S','S N2 D1 P M2 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[6,'M2'],[7,'P'],[8,'D1'],[10,'N2']]),
    R('Simhendramadhyamam',57,'S R2 G2 M2 P D1 N3 S','S N3 D1 P M2 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[6,'M2'],[7,'P'],[8,'D1'],[11,'N3']]),
    R('Dharmavati',59,'S R2 G2 M2 P D2 N3 S','S N3 D2 P M2 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[6,'M2'],[7,'P'],[9,'D2'],[11,'N3']]),
    R('Latangi',63,'S R2 G3 M2 P D1 N3 S','S N3 D1 P M2 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[6,'M2'],[7,'P'],[8,'D1'],[11,'N3']]),
    R('Vachaspati',64,'S R2 G3 M2 P D2 N2 S','S N2 D2 P M2 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[6,'M2'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Kalyani',65,'S R2 G3 M2 P D2 N3 S','S N3 D2 P M2 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[6,'M2'],[7,'P'],[9,'D2'],[11,'N3']]),
    // --- janya ---
    R('Mohanam',28,'S R2 G3 P D2 S','S D2 P G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[7,'P'],[9,'D2']]),
    R('Hamsadhwani',29,'S R2 G3 P N3 S','S N3 P G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[7,'P'],[11,'N3']]),
    R('Hindolam',20,'S G2 M1 D1 N2 S','S N2 D1 M1 G2 S',[[0,'S'],[3,'G2'],[5,'M1'],[8,'D1'],[10,'N2']]),
    R('Madhyamavati',22,'S R2 M1 P N2 S','S N2 P M1 R2 S',[[0,'S'],[2,'R2'],[5,'M1'],[7,'P'],[10,'N2']]),
    R('Shuddha Saveri',29,'S R2 M1 P D2 S','S D2 P M1 R2 S',[[0,'S'],[2,'R2'],[5,'M1'],[7,'P'],[9,'D2']]),
    R('Shuddha Dhanyasi',22,'S G2 M1 P N2 S','S N2 P M1 G2 S',[[0,'S'],[3,'G2'],[5,'M1'],[7,'P'],[10,'N2']]),
    R('Abhogi',22,'S R2 G2 M1 D2 S','S D2 M1 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[5,'M1'],[9,'D2']]),
    R('Sriranjani',22,'S R2 G2 M1 D2 N2 S','S N2 D2 M1 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[5,'M1'],[9,'D2'],[10,'N2']]),
    R('Revati',2,'S R1 M1 P N2 S','S N2 P M1 R1 S',[[0,'S'],[1,'R1'],[5,'M1'],[7,'P'],[10,'N2']]),
    R('Valaji',28,'S G3 P D2 N2 S','S N2 D2 P G3 S',[[0,'S'],[4,'G3'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Bahudari',28,'S G3 M1 P D2 N2 S','S N2 P M1 G3 S',[[0,'S'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Malahari',15,'S R1 M1 P D1 S','S D1 P M1 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[5,'M1'],[7,'P'],[8,'D1']]),
    R('Nattai',36,'S R3 G3 M1 P D3 N3 S','S N3 P M1 R3 S',[[0,'S'],[3,'R3'],[4,'G3'],[5,'M1'],[7,'P'],[10,'D3'],[11,'N3']]),
    R('Gowla',15,'S R1 M1 P N3 S','S N3 P M1 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[5,'M1'],[7,'P'],[11,'N3']]),
    R('Arabhi',29,'S R2 M1 P D2 S','S N3 D2 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[11,'N3']]),
    R('Bilahari',29,'S R2 G3 P D2 S','S N3 D2 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[11,'N3']]),
    R('Kambhoji',28,'S R2 G3 M1 P D2 S','S N2 D2 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Kedaragowla',28,'S R2 M1 P N2 S','S N2 D2 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Sahana',28,'S R2 G3 M1 P M1 D2 N2 S','S N2 D2 P M1 G3 M1 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Bhairavi',20,'S R2 G2 M1 P D2 N2 S','S N2 D1 P M1 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[5,'M1'],[7,'P'],[8,'D1'],[9,'D2'],[10,'N2']]),
    R('Anandabhairavi',22,'S G2 R2 G2 M1 P D2 P S','S N2 D2 P M1 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2'],[11,'N3']]),
    R('Reetigowla',22,'S G2 R2 G2 M1 N2 D2 M1 N2 N2 S','S N2 D2 M1 G2 M1 P M1 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Saveri',15,'S R1 M1 P D1 S','S N3 D1 P M1 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[5,'M1'],[7,'P'],[8,'D1'],[11,'N3']]),
    R('Dhanyasi',8,'S G2 M1 P N2 S','S N2 D1 P M1 G2 R1 S',[[0,'S'],[1,'R1'],[3,'G2'],[5,'M1'],[7,'P'],[8,'D1'],[10,'N2']]),
    R('Amritavarshini',66,'S G3 M2 P N3 S','S N3 P M2 G3 S',[[0,'S'],[4,'G3'],[6,'M2'],[7,'P'],[11,'N3']]),
    R('Ranjani',59,'S R2 G2 M2 D2 S','S N3 D2 M2 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[6,'M2'],[9,'D2'],[11,'N3']]),
    R('Hamsanandi',53,'S R1 G3 M2 D2 N3 S','S N3 D2 M2 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[6,'M2'],[9,'D2'],[11,'N3']]),
    R('Nalinakanti',27,'S R2 G3 M1 P N3 S','S N3 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[11,'N3']]),
    R('Kapi',22,'S R2 M1 P N2 S','S N2 D2 N2 P M1 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2'],[11,'N3']]),
    R('Kamas',28,'S M1 G3 M1 P D2 N2 S','S N2 D2 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Saurashtram',17,'S R1 G3 M1 P M1 D2 N3 S','S N3 D2 N2 D2 P M1 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2'],[11,'N3']]),
    R('Begada',29,'S G3 R2 G3 M1 P D2 P S','S N2 D2 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Surati',28,'S R2 M1 P N2 S','S N2 D2 P M1 G3 P M1 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Kanada',22,'S R2 G2 M1 D2 N2 S','S N2 P M1 G2 M1 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Kuntalavarali',28,'S M1 P D2 N2 D2 S','S N2 D2 P M1 S',[[0,'S'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Padi',15,'S R1 M1 P N3 S','S N3 P D1 P M1 R1 S',[[0,'S'],[1,'R1'],[5,'M1'],[7,'P'],[8,'D1'],[11,'N3']]),
    R('Kumudakriya',51,'S R1 G3 M2 D1 S','S N3 D1 M2 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[6,'M2'],[8,'D1'],[11,'N3']]),
    R('Purvikalyani',53,'S R1 G3 M2 P D2 P S','S N3 D2 P M2 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[6,'M2'],[7,'P'],[9,'D2'],[11,'N3']]),
    R('Vasanta',17,'S G3 M1 D2 N3 S','S N3 D2 M1 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[5,'M1'],[9,'D2'],[11,'N3']]),
    R('Sindhubhairavi',22,'S R2 G2 M1 P D2 N2 S','S N2 D1 P M1 G2 R1 S',[[0,'S'],[1,'R1'],[2,'R2'],[3,'G2'],[4,'G3'],[5,'M1'],[7,'P'],[8,'D1'],[9,'D2'],[10,'N2'],[11,'N3']]),
    R('Desh',28,'S R2 M1 P N3 S','S N2 D2 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2'],[11,'N3']]),
    R('Behag',29,'S G3 M1 P N3 S','S N3 D2 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[6,'M2'],[7,'P'],[9,'D2'],[11,'N3']]),
    // -- remaining melakarta (parent) ragas: complete, sampoorna (all 7 notes),
    // straight aroha/avaroha by definition -- verified against the standard 72-mela table.
    R('Ratnangi',2,'S R1 G1 M1 P D1 N2 S','S N2 D1 P M1 G1 R1 S',[[0,'S'],[1,'R1'],[2,'G1'],[5,'M1'],[7,'P'],[8,'D1'],[10,'N2']]),
    R('Ganamurti',3,'S R1 G1 M1 P D1 N3 S','S N3 D1 P M1 G1 R1 S',[[0,'S'],[1,'R1'],[2,'G1'],[5,'M1'],[7,'P'],[8,'D1'],[11,'N3']]),
    R('Vanaspati',4,'S R1 G1 M1 P D2 N2 S','S N2 D2 P M1 G1 R1 S',[[0,'S'],[1,'R1'],[2,'G1'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Manavati',5,'S R1 G1 M1 P D2 N3 S','S N3 D2 P M1 G1 R1 S',[[0,'S'],[1,'R1'],[2,'G1'],[5,'M1'],[7,'P'],[9,'D2'],[11,'N3']]),
    R('Tanarupi',6,'S R1 G1 M1 P D3 N3 S','S N3 D3 P M1 G1 R1 S',[[0,'S'],[1,'R1'],[2,'G1'],[5,'M1'],[7,'P'],[10,'D3'],[11,'N3']]),
    R('Senavati',7,'S R1 G2 M1 P D1 N1 S','S N1 D1 P M1 G2 R1 S',[[0,'S'],[1,'R1'],[3,'G2'],[5,'M1'],[7,'P'],[8,'D1'],[9,'N1']]),
    R('Dhenuka',9,'S R1 G2 M1 P D1 N3 S','S N3 D1 P M1 G2 R1 S',[[0,'S'],[1,'R1'],[3,'G2'],[5,'M1'],[7,'P'],[8,'D1'],[11,'N3']]),
    R('Natakapriya',10,'S R1 G2 M1 P D2 N2 S','S N2 D2 P M1 G2 R1 S',[[0,'S'],[1,'R1'],[3,'G2'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Kokilapriya',11,'S R1 G2 M1 P D2 N3 S','S N3 D2 P M1 G2 R1 S',[[0,'S'],[1,'R1'],[3,'G2'],[5,'M1'],[7,'P'],[9,'D2'],[11,'N3']]),
    R('Rupavati',12,'S R1 G2 M1 P D3 N3 S','S N3 D3 P M1 G2 R1 S',[[0,'S'],[1,'R1'],[3,'G2'],[5,'M1'],[7,'P'],[10,'D3'],[11,'N3']]),
    R('Gayakapriya',13,'S R1 G3 M1 P D1 N1 S','S N1 D1 P M1 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[5,'M1'],[7,'P'],[8,'D1'],[9,'N1']]),
    R('Suryakantam',17,'S R1 G3 M1 P D2 N3 S','S N3 D2 P M1 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[11,'N3']]),
    R('Hatakambari',18,'S R1 G3 M1 P D3 N3 S','S N3 D3 P M1 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[5,'M1'],[7,'P'],[10,'D3'],[11,'N3']]),
    R('Jhankaradhwani',19,'S R2 G2 M1 P D1 N1 S','S N1 D1 P M1 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[5,'M1'],[7,'P'],[8,'D1'],[9,'N1']]),
    R('Varunapriya',24,'S R2 G2 M1 P D3 N3 S','S N3 D3 P M1 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[5,'M1'],[7,'P'],[10,'D3'],[11,'N3']]),
    R('Mararanjani',25,'S R2 G3 M1 P D1 N1 S','S N1 D1 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[8,'D1'],[9,'N1']]),
    R('Sarasangi',27,'S R2 G3 M1 P D1 N3 S','S N3 D1 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[8,'D1'],[11,'N3']]),
    R('Naganandini',30,'S R2 G3 M1 P D3 N3 S','S N3 D3 P M1 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[5,'M1'],[7,'P'],[10,'D3'],[11,'N3']]),
    R('Yagapriya',31,'S R3 G3 M1 P D1 N1 S','S N1 D1 P M1 G3 R3 S',[[0,'S'],[3,'R3'],[4,'G3'],[5,'M1'],[7,'P'],[8,'D1'],[9,'N1']]),
    R('Ragavardhini',32,'S R3 G3 M1 P D1 N2 S','S N2 D1 P M1 G3 R3 S',[[0,'S'],[3,'R3'],[4,'G3'],[5,'M1'],[7,'P'],[8,'D1'],[10,'N2']]),
    R('Gangeyabhushani',33,'S R3 G3 M1 P D1 N3 S','S N3 D1 P M1 G3 R3 S',[[0,'S'],[3,'R3'],[4,'G3'],[5,'M1'],[7,'P'],[8,'D1'],[11,'N3']]),
    R('Vagadheeswari',34,'S R3 G3 M1 P D2 N2 S','S N2 D2 P M1 G3 R3 S',[[0,'S'],[3,'R3'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Shulini',35,'S R3 G3 M1 P D2 N3 S','S N3 D2 P M1 G3 R3 S',[[0,'S'],[3,'R3'],[4,'G3'],[5,'M1'],[7,'P'],[9,'D2'],[11,'N3']]),
    R('Salagam',37,'S R1 G1 M2 P D1 N1 S','S N1 D1 P M2 G1 R1 S',[[0,'S'],[1,'R1'],[2,'G1'],[6,'M2'],[7,'P'],[8,'D1'],[9,'N1']]),
    R('Jalarnavam',38,'S R1 G1 M2 P D1 N2 S','S N2 D1 P M2 G1 R1 S',[[0,'S'],[1,'R1'],[2,'G1'],[6,'M2'],[7,'P'],[8,'D1'],[10,'N2']]),
    R('Navaneetam',40,'S R1 G1 M2 P D2 N2 S','S N2 D2 P M2 G1 R1 S',[[0,'S'],[1,'R1'],[2,'G1'],[6,'M2'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Pavani',41,'S R1 G1 M2 P D2 N3 S','S N3 D2 P M2 G1 R1 S',[[0,'S'],[1,'R1'],[2,'G1'],[6,'M2'],[7,'P'],[9,'D2'],[11,'N3']]),
    R('Raghupriya',42,'S R1 G1 M2 P D3 N3 S','S N3 D3 P M2 G1 R1 S',[[0,'S'],[1,'R1'],[2,'G1'],[6,'M2'],[7,'P'],[10,'D3'],[11,'N3']]),
    R('Gavambodhi',43,'S R1 G2 M2 P D1 N1 S','S N1 D1 P M2 G2 R1 S',[[0,'S'],[1,'R1'],[3,'G2'],[6,'M2'],[7,'P'],[8,'D1'],[9,'N1']]),
    R('Bhavapriya',44,'S R1 G2 M2 P D1 N2 S','S N2 D1 P M2 G2 R1 S',[[0,'S'],[1,'R1'],[3,'G2'],[6,'M2'],[7,'P'],[8,'D1'],[10,'N2']]),
    R('Shadvidhamargini',46,'S R1 G2 M2 P D2 N2 S','S N2 D2 P M2 G2 R1 S',[[0,'S'],[1,'R1'],[3,'G2'],[6,'M2'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Suvarnangi',47,'S R1 G2 M2 P D2 N3 S','S N3 D2 P M2 G2 R1 S',[[0,'S'],[1,'R1'],[3,'G2'],[6,'M2'],[7,'P'],[9,'D2'],[11,'N3']]),
    R('Divyamani',48,'S R1 G2 M2 P D3 N3 S','S N3 D3 P M2 G2 R1 S',[[0,'S'],[1,'R1'],[3,'G2'],[6,'M2'],[7,'P'],[10,'D3'],[11,'N3']]),
    R('Dhavalambari',49,'S R1 G3 M2 P D1 N1 S','S N1 D1 P M2 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[6,'M2'],[7,'P'],[8,'D1'],[9,'N1']]),
    R('Namanarayani',50,'S R1 G3 M2 P D1 N2 S','S N2 D1 P M2 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[6,'M2'],[7,'P'],[8,'D1'],[10,'N2']]),
    R('Kamavardhani',51,'S R1 G3 M2 P D1 N3 S','S N3 D1 P M2 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[6,'M2'],[7,'P'],[8,'D1'],[11,'N3']]),
    R('Ramapriya',52,'S R1 G3 M2 P D2 N2 S','S N2 D2 P M2 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[6,'M2'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Gamanashrama',53,'S R1 G3 M2 P D2 N3 S','S N3 D2 P M2 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[6,'M2'],[7,'P'],[9,'D2'],[11,'N3']]),
    R('Vishwambhari',54,'S R1 G3 M2 P D3 N3 S','S N3 D3 P M2 G3 R1 S',[[0,'S'],[1,'R1'],[4,'G3'],[6,'M2'],[7,'P'],[10,'D3'],[11,'N3']]),
    R('Shyamalangi',55,'S R2 G2 M2 P D1 N1 S','S N1 D1 P M2 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[6,'M2'],[7,'P'],[8,'D1'],[9,'N1']]),
    R('Hemavati',58,'S R2 G2 M2 P D2 N2 S','S N2 D2 P M2 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[6,'M2'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Nitimati',60,'S R2 G2 M2 P D3 N3 S','S N3 D3 P M2 G2 R2 S',[[0,'S'],[2,'R2'],[3,'G2'],[6,'M2'],[7,'P'],[10,'D3'],[11,'N3']]),
    R('Kantamani',61,'S R2 G3 M2 P D1 N1 S','S N1 D1 P M2 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[6,'M2'],[7,'P'],[8,'D1'],[9,'N1']]),
    R('Rishabhapriya',62,'S R2 G3 M2 P D1 N2 S','S N2 D1 P M2 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[6,'M2'],[7,'P'],[8,'D1'],[10,'N2']]),
    R('Chitrambari',66,'S R2 G3 M2 P D3 N3 S','S N3 D3 P M2 G3 R2 S',[[0,'S'],[2,'R2'],[4,'G3'],[6,'M2'],[7,'P'],[10,'D3'],[11,'N3']]),
    R('Sucharitra',67,'S R3 G3 M2 P D1 N1 S','S N1 D1 P M2 G3 R3 S',[[0,'S'],[3,'R3'],[4,'G3'],[6,'M2'],[7,'P'],[8,'D1'],[9,'N1']]),
    R('Jyotiswarupini',68,'S R3 G3 M2 P D1 N2 S','S N2 D1 P M2 G3 R3 S',[[0,'S'],[3,'R3'],[4,'G3'],[6,'M2'],[7,'P'],[8,'D1'],[10,'N2']]),
    R('Dhatuvardhani',69,'S R3 G3 M2 P D1 N3 S','S N3 D1 P M2 G3 R3 S',[[0,'S'],[3,'R3'],[4,'G3'],[6,'M2'],[7,'P'],[8,'D1'],[11,'N3']]),
    R('Nasikabhushani',70,'S R3 G3 M2 P D2 N2 S','S N2 D2 P M2 G3 R3 S',[[0,'S'],[3,'R3'],[4,'G3'],[6,'M2'],[7,'P'],[9,'D2'],[10,'N2']]),
    R('Kosalam',71,'S R3 G3 M2 P D2 N3 S','S N3 D2 P M2 G3 R3 S',[[0,'S'],[3,'R3'],[4,'G3'],[6,'M2'],[7,'P'],[9,'D2'],[11,'N3']]),
    R('Rasikapriya',72,'S R3 G3 M2 P D3 N3 S','S N3 D3 P M2 G3 R3 S',[[0,'S'],[3,'R3'],[4,'G3'],[6,'M2'],[7,'P'],[10,'D3'],[11,'N3']]),
    R('Chromatic (all 12)',null,'S R1 R2 G2 G3 M1 M2 P D1 D2 N2 N3 S','S N3 N2 D2 D1 P M2 M1 G3 G2 R2 R1 S',
      [[0,'S'],[1,'R1'],[2,'R2'],[3,'G2'],[4,'G3'],[5,'M1'],[6,'M2'],[7,'P'],[8,'D1'],[9,'D2'],[10,'N2'],[11,'N3']])
  ];

  // ---------- raga grammar: directional legality ----------
  // From the aroha/avaroha strings: which svara labels may be *entered* while
  // ascending vs descending. Captures asymmetric ragas (e.g. Bilahari: N3 and
  // M1 appear only in avarohana) without over-constraining phrase jumps.
  function dirSets(ragam) {
    function labels(s) {
      var set = {};
      String(s || '').split(/\s+/).forEach(function (t) {
        t = t.replace(/[^A-Za-z0-9]/g, '');
        if (t) set[t] = true;
      });
      return set;
    }
    return { up: labels(ragam.aroh), down: labels(ragam.avaroh) };
  }

  // ---------- resampling / mixdown ----------
  function mixdownResample(channels, srIn, srOut) {
    var n = channels[0].length, ch = channels.length;
    var mono = new Float32Array(n), i, c;
    for (i = 0; i < n; i++) {
      var s = 0;
      for (c = 0; c < ch; c++) s += channels[c][i];
      mono[i] = s / ch;
    }
    if (srIn === srOut) return mono;
    var ratio = srIn / srOut;
    var m = Math.floor(n / ratio);
    var out = new Float32Array(m);
    for (i = 0; i < m; i++) {
      var x = i * ratio, i0 = Math.floor(x), f = x - i0;
      var a = mono[i0] || 0, b = mono[i0 + 1] !== undefined ? mono[i0 + 1] : a;
      out[i] = a + (b - a) * f;
    }
    return out;
  }

  // ---------- YIN pitch tracking ----------
  // Returns {t, f0, conf, rms} arrays
  function yinTrack(x, sr, opts) {
    opts = opts || {};
    var W = opts.window || 800;          // 50 ms @16k
    var hop = opts.hop || 256;           // 16 ms
    var fmin = opts.fmin || 70, fmax = opts.fmax || 900;
    var tauMax = Math.min(Math.floor(sr / fmin), W - 1);
    var tauMin = Math.max(2, Math.floor(sr / fmax));
    var thresh = opts.threshold || 0.15;

    var nFrames = Math.max(0, Math.floor((x.length - W - tauMax) / hop));
    var fStart = opts.frameStart || 0;
    var fEnd = opts.frameEnd === undefined ? nFrames : Math.min(nFrames, opts.frameEnd);
    var count = Math.max(0, fEnd - fStart);
    var f0 = new Float32Array(count), conf = new Float32Array(count), rms = new Float32Array(count);
    var d = new Float32Array(tauMax + 1), cm = new Float32Array(tauMax + 1);

    for (var fi = 0, gf = fStart; fi < count; fi++, gf++) {
      var off = gf * hop, j, tau, e = 0;
      for (j = 0; j < W; j++) e += x[off + j] * x[off + j];
      rms[fi] = Math.sqrt(e / W);

      for (tau = 1; tau <= tauMax; tau++) {
        var sum = 0;
        for (j = 0; j < W; j++) { var diff = x[off + j] - x[off + j + tau]; sum += diff * diff; }
        d[tau] = sum;
      }
      var run = 0; cm[0] = 1;
      for (tau = 1; tau <= tauMax; tau++) { run += d[tau]; cm[tau] = run === 0 ? 1 : d[tau] * tau / run; }

      var best = -1;
      for (tau = tauMin; tau <= tauMax; tau++) {
        if (cm[tau] < thresh) {
          while (tau + 1 <= tauMax && cm[tau + 1] < cm[tau]) tau++;
          best = tau; break;
        }
      }
      if (best < 0) {
        var mn = Infinity;
        for (tau = tauMin; tau <= tauMax; tau++) if (cm[tau] < mn) { mn = cm[tau]; best = tau; }
      }
      // parabolic interpolation
      var t0 = best, better = t0;
      if (t0 > tauMin && t0 < tauMax) {
        var y0 = cm[t0 - 1], y1 = cm[t0], y2 = cm[t0 + 1];
        var den = 2 * (2 * y1 - y2 - y0);
        if (den !== 0) better = t0 + (y2 - y0) / den;
      }
      f0[fi] = better > 0 ? sr / better : 0;
      conf[fi] = Math.max(0, Math.min(1, 1 - cm[best]));
    }
    return { f0: f0, conf: conf, rms: rms, hop: hop, sr: sr,
             nFrames: count, totalFrames: nFrames, frameStart: fStart };
  }

  // ---------- cents, voicing, octave repair ----------
  function toCents(f0, tonicHz) {
    var c = new Float32Array(f0.length);
    for (var i = 0; i < f0.length; i++) c[i] = f0[i] > 0 ? 1200 * Math.log2(f0[i] / tonicHz) : NaN;
    return c;
  }

  function medianOf(arr) {
    var a = arr.slice().sort(function (p, q) { return p - q; });
    var n = a.length; if (!n) return NaN;
    return n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
  }

  function voicingMask(track, opts) {
    var minConf = opts.minConf, rms = track.rms;
    var peak = 0, i;
    for (i = 0; i < rms.length; i++) if (rms[i] > peak) peak = rms[i];
    var floor = peak * (opts.silenceRatio || 0.045);
    var v = new Uint8Array(track.nFrames);
    for (i = 0; i < v.length; i++) v[i] = (track.conf[i] >= minConf && rms[i] > floor) ? 1 : 0;
    return v;
  }

  function repairOctaves(cents, voiced, win) {
    win = win || 8;
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < cents.length; i++) {
        if (!voiced[i]) continue;
        var buf = [];
        for (var k = i - win; k <= i + win; k++) if (k >= 0 && k < cents.length && voiced[k] && k !== i) buf.push(cents[k]);
        if (buf.length < 4) continue;
        var m = medianOf(buf), dv = cents[i] - m;
        if (Math.abs(dv - 1200) < 260) cents[i] -= 1200;
        else if (Math.abs(dv + 1200) < 260) cents[i] += 1200;
      }
    }
    return cents;
  }

  function medianSmooth(cents, voiced, w) {
    var out = Float32Array.from(cents);
    for (var i = 0; i < cents.length; i++) {
      if (!voiced[i]) continue;
      var buf = [];
      for (var k = i - w; k <= i + w; k++) if (k >= 0 && k < cents.length && voiced[k]) buf.push(cents[k]);
      if (buf.length) out[i] = medianOf(buf);
    }
    return out;
  }

  // ---------- pitch-class histogram (for sruthi check + ragam ID) ----------
  function pitchHistogram(cents, voiced, conf, binCents) {
    binCents = binCents || 5;
    var nb = Math.round(1200 / binCents);
    var h = new Float64Array(nb);
    for (var i = 0; i < cents.length; i++) {
      if (!voiced[i] || !isFinite(cents[i])) continue;
      var pc = ((cents[i] % 1200) + 1200) % 1200;
      var b = Math.floor(pc / binCents) % nb;
      h[b] += conf[i];
    }
    // circular gaussian smoothing (sigma ~ 12 cents)
    var sig = 12 / binCents, rad = Math.ceil(sig * 3), out = new Float64Array(nb);
    for (var b2 = 0; b2 < nb; b2++) {
      var acc = 0, wsum = 0;
      for (var k = -rad; k <= rad; k++) {
        var w = Math.exp(-0.5 * (k / sig) * (k / sig));
        acc += w * h[((b2 + k) % nb + nb) % nb]; wsum += w;
      }
      out[b2] = acc / wsum;
    }
    return { bins: out, binCents: binCents };
  }

  // Best tonic shift: which rotation of the histogram best fits the ragam template
  function tonicOffset(hist, svaraPositions, temperament, maxShift) {
    maxShift = maxShift || 120; // +/- cents to consider
    var nb = hist.bins.length, bc = hist.binCents;
    var best = { shift: 0, score: -1 };
    for (var s = -maxShift; s <= maxShift; s += bc) {
      var score = 0;
      for (var p = 0; p < svaraPositions.length; p++) {
        var target = centsOf(svaraPositions[p], temperament) + s;
        for (var k = -6; k <= 6; k++) { // +/-30 cents window
          var b = Math.round((target + k * bc) / bc);
          b = ((b % nb) + nb) % nb;
          score += hist.bins[b] * Math.exp(-0.5 * Math.pow(k * bc / 22, 2));
        }
      }
      if (score > best.score) best = { shift: s, score: score };
    }
    return best;
  }

  function ragamMatches(hist, temperament, topN) {
    var nb = hist.bins.length, bc = hist.binCents;
    // fold to 12-dim energy vector
    var v = new Float64Array(12), total = 0, i;
    for (i = 0; i < nb; i++) {
      var c = i * bc, bestP = 0, bestD = 1e9;
      for (var p = 0; p < 12; p++) {
        var d = Math.abs(((c - centsOf(p, temperament) + 1800) % 1200) - 600);
        if (d < bestD) { bestD = d; bestP = p; }
      }
      v[bestP] += hist.bins[i]; total += hist.bins[i];
    }
    if (total > 0) for (i = 0; i < 12; i++) v[i] /= total;
    var vn = Math.sqrt(v.reduce(function (a, b) { return a + b * b; }, 0)) || 1;
    var out = RAGAMS.map(function (r) {
      var t = new Float64Array(12);
      r.svaras.forEach(function (sv) { t[sv[0]] = 1; });
      var dot = 0, tn = Math.sqrt(r.svaras.length);
      for (var j = 0; j < 12; j++) dot += v[j] * t[j];
      return { name: r.name, score: dot / (vn * tn) };
    }).sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, topN || 5);
  }

  // ---------- Viterbi svara decoding ----------
  function buildStates(ragam, temperament, minCents, maxCents) {
    var states = [];
    for (var oct = -3; oct <= 3; oct++) {
      for (var i = 0; i < ragam.svaras.length; i++) {
        var pos = ragam.svaras[i][0], label = ragam.svaras[i][1];
        var c = oct * 1200 + centsOf(pos, temperament);
        if (c < minCents - 150 || c > maxCents + 150) continue;
        states.push({ cents: c, pos: pos, label: label, oct: oct });
      }
    }
    states.sort(function (a, b) { return a.cents - b.cents; });
    return states;
  }

  function viterbi(cents, voiced, conf, states, opts) {
    var N = cents.length, K = states.length;
    if (!K || !N) return new Int32Array(N).fill(-1);
    var sigma = opts.sigma || 55;         // cents; wide enough to absorb gamaka
    var lambda = opts.switchPenalty;      // log-penalty for changing svara
    var silPen = opts.silencePenalty || 6;
    var dirs = opts.dirSets || null;      // {up:{label:true}, down:{...}} or null
    var dirPen = opts.dirPenalty === undefined ? 1.0 * lambda : opts.dirPenalty;
    var SIL = K;                          // extra silence state
    var prev = new Float64Array(K + 1), cur = new Float64Array(K + 1);
    var bp = new Int32Array(N * (K + 1));
    var i, k, j;

    // Directional grammar. Two mechanisms:
    //  (a) transition: entering a direction-illegal svara costs extra (phrase level)
    //  (b) emission: *occupying* a direction-illegal svara during a clear glide
    //      costs per frame. The slope is smoothed over ~160 ms so kampita
    //      oscillation averages to ~zero and gamaka is never penalized.
    var slope = null;
    if (dirs) {
      var w = 5; // frames each side (~80 ms at 16 ms hop)
      var fps = 1; // slope units: cents per frame is fine, threshold below matches
      slope = new Float32Array(N);
      for (i = 0; i < N; i++) {
        var a = Math.max(0, i - w), b = Math.min(N - 1, i + w);
        while (a < i && (!voiced[a] || !isFinite(cents[a]))) a++;
        while (b > i && (!voiced[b] || !isFinite(cents[b]))) b--;
        if (b > a && voiced[a] && voiced[b] && isFinite(cents[a]) && isFinite(cents[b]))
          slope[i] = (cents[b] - cents[a]) / (b - a);
      }
    }
    var SLOPE_MIN = 4;      // cents/frame (~250 cents/s at 16 ms hop): a clear glide
    var occPen = opts.occupancyPenalty === undefined ? 2.2 : opts.occupancyPenalty;

    function emit(i, k) {
      if (k === SIL) return voiced[i] ? -silPen : 0;
      if (!voiced[i]) return -silPen;
      var z = (cents[i] - states[k].cents) / sigma;
      var e = -0.5 * z * z * (0.35 + 0.65 * conf[i]);
      if (dirs && states[k].label !== 'S') {
        if (slope[i] > SLOPE_MIN && !dirs.up[states[k].label]) e -= occPen;
        else if (slope[i] < -SLOPE_MIN && !dirs.down[states[k].label]) e -= occPen;
      }
      return e;
    }

    // Directional legality of *entering* state k while moving up/down.
    // Sa is always legal (it anchors both directions in every raga).
    function dirCost(fromK, toK) {
      if (!dirs || fromK === SIL || toK === SIL || fromK === toK) return 0;
      var lab = states[toK].label;
      if (lab === 'S') return 0;
      var ascending = states[toK].cents > states[fromK].cents;
      var legal = ascending ? dirs.up[lab] : dirs.down[lab];
      return legal ? 0 : dirPen;
    }

    for (k = 0; k <= K; k++) prev[k] = emit(0, k);
    for (i = 1; i < N; i++) {
      for (k = 0; k <= K; k++) {
        var bestV = prev[k], bestB = k;   // staying is free
        for (j = 0; j <= K; j++) {
          if (j === k) continue;
          var pen = lambda + dirCost(j, k);
          if (j === SIL || k === SIL) pen = 1.5 * lambda;
          var v = prev[j] - pen;
          if (v > bestV) { bestV = v; bestB = j; }
        }
        cur[k] = bestV + emit(i, k);
        bp[i * (K + 1) + k] = bestB;
      }
      for (k = 0; k <= K; k++) prev[k] = cur[k];
    }
    var path = new Int32Array(N), endBest = 0;
    for (k = 1; k <= K; k++) if (prev[k] > prev[endBest]) endBest = k;
    path[N - 1] = endBest;
    for (i = N - 1; i > 0; i--) path[i - 1] = bp[i * (K + 1) + path[i]];
    for (i = 0; i < N; i++) if (path[i] === SIL) path[i] = -1;
    return path;
  }

  // ---------- notes ----------
  function pathToNotes(path, cents, states, hop, sr, opts) {
    var frameDur = hop / sr;
    var notes = [], i = 0, N = path.length;
    while (i < N) {
      if (path[i] < 0) { i++; continue; }
      var j = i;
      while (j + 1 < N && path[j + 1] === path[i]) j++;
      var st = states[path[i]];
      var vals = [];
      for (var k = i; k <= j; k++) if (isFinite(cents[k])) vals.push(cents[k]);
      var dur = (j - i + 1) * frameDur;
      if (vals.length && dur >= opts.minNoteDur) {
        var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
        var varc = vals.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / vals.length;
        var sd = Math.sqrt(varc);
        var q = Math.max(1, Math.floor(vals.length / 4));
        var head = medianOf(vals.slice(0, q)), tail = medianOf(vals.slice(-q));
        var slide = tail - head;
        var artic = 'plain';
        if (Math.abs(slide) > 90 && sd > 32) artic = slide > 0 ? 'slide-up' : 'slide-down';
        else if (sd > 48) artic = 'kampita';
        else if (sd > 22) artic = 'light';
        notes.push({
          start: i * frameDur, end: (j + 1) * frameDur, dur: dur,
          label: st.label, pos: st.pos, oct: st.oct, cents: st.cents,
          meanCents: mean, sd: sd, slide: slide, artic: artic,
          deviation: mean - st.cents,
          conf: Math.max(0, Math.min(1, 1 - sd / 160))
        });
      }
      i = j + 1;
    }
    // Mark short notes that sit inside a monotonic run as transit tones (part of a
    // glide / fast passage) rather than svaras a listener would name.
    var tmax = opts.transientMax === undefined ? 0.12 : opts.transientMax;
    for (var m = 1; m < notes.length - 1; m++) {
      var a = notes[m - 1], b = notes[m], c = notes[m + 1];
      if (b.dur >= tmax) continue;
      var up = (b.cents - a.cents) > 0 && (c.cents - b.cents) > 0;
      var dn = (b.cents - a.cents) < 0 && (c.cents - b.cents) < 0;
      var gapA = b.start - a.end, gapC = c.start - b.end;
      if ((up || dn) && gapA < 0.05 && gapC < 0.05 && (a.dur > b.dur * 1.5 || c.dur > b.dur * 1.5)) {
        b.transit = true;
      }
    }
    return notes;
  }

  var SUB_DOT = '\u0323', SUP_DOT = '\u0307';
  function renderSvara(note, marks) {
    var s = note.label;
    if (note.oct <= -1) s = s[0] + SUB_DOT + s.slice(1);
    else if (note.oct >= 1) s = s[0] + SUP_DOT + s.slice(1);
    if (note.oct <= -2) s += SUB_DOT;
    if (note.oct >= 2) s += SUP_DOT;
    if (marks) {
      if (note.artic === 'kampita') s += '~';
      else if (note.artic === 'slide-up') s += '/';
      else if (note.artic === 'slide-down') s += '\\';
    }
    return s;
  }

  // ---------- tala: suladi sapta talam (7 talas x 5 jathis = 35) ----------
  // Angas verified against Sangita Ratnakara-derived pedagogical sources:
  // anudrutam=1, drutam=2 (both fixed), laghu=jathi count (variable).
  // Adi talam = Chaturasra-jati Triputa = laghu(4)+drutam(2)+drutam(2) = 8.
  var TALAS = [
    { name: 'Dhruva',  angas: ['L', 'D', 'L', 'L'] },
    { name: 'Matya',   angas: ['L', 'D', 'L'] },
    { name: 'Rupaka',  angas: ['D', 'L'] },
    { name: 'Jhampa',  angas: ['L', 'A', 'D'] },
    { name: 'Triputa', angas: ['L', 'D', 'D'] },
    { name: 'Ata',     angas: ['L', 'L', 'D', 'D'] },
    { name: 'Eka',     angas: ['L'] }
  ];
  var JATHIS = [
    { name: 'Tisra', beats: 3 }, { name: 'Chaturasra', beats: 4 },
    { name: 'Khanda', beats: 5 }, { name: 'Misra', beats: 7 },
    { name: 'Sankeerna', beats: 9 }
  ];
  function avartanaBeats(tala, jathi) {
    return tala.angas.reduce(function (sum, a) {
      return sum + (a === 'L' ? jathi.beats : a === 'D' ? 2 : 1);
    }, 0);
  }
  // Cumulative beat position (within one avartana) where each anga ends.
  // e.g. Adi (Triputa, Chaturasra: L,D,D) -> [4, 6, 8]. The last entry always
  // equals avartanaBeats() -- that's the avartana boundary itself, not an
  // interior anga split.
  function angaBoundaries(tala, jathi) {
    var cum = 0;
    return tala.angas.map(function (a) {
      cum += (a === 'L' ? jathi.beats : a === 'D' ? 2 : 1);
      return cum;
    });
  }
  var COMMON_TALA = { 'Triputa:Chaturasra': 'Adi', 'Ata:Khanda': 'Khanda Ata',
    'Triputa:Tisra': 'Rupaka (as chapu-style 3)', 'Eka:Chaturasra': 'Chaturasra Eka' };
  function talaLabel(tala, jathi) {
    var key = tala.name + ':' + jathi.name, common = COMMON_TALA[key];
    return jathi.name + ' ' + tala.name + (common ? ' (' + common + ')' : '') +
      ' \u2014 ' + avartanaBeats(tala, jathi) + ' beats';
  }
  function allTalas() {
    var out = [];
    TALAS.forEach(function (t) { JATHIS.forEach(function (j) {
      out.push({ tala: t.name, jathi: j.name, angas: t.angas, beats: avartanaBeats(t, j),
        label: talaLabel(t, j) });
    }); });
    return out;
  }

  // A note occupies 1 beat by default; commas (a held-note convention) add
  // beats; a shared beatGroup (2nd/3rd speed) makes several notes share one
  // beat instead. commaCount() prefers a manual correction over the
  // duration-derived guess so an edit is never silently overwritten by
  // re-render, but the guess is still the honest default for untouched notes.
  function commaCount(note, unit) {
    if (note.commaEdited) return note.commas | 0;
    if (!unit) return 0;
    return Math.max(0, Math.min(7, Math.round(note.dur / unit) - 1));
  }

  function notationText(notes, opts) {
    opts = opts || {};
    if (!notes.length) return '';
    var durs = notes.map(function (n) { return n.dur; }).sort(function (a, b) { return a - b; });
    var unit = opts.unit || durs[Math.floor(durs.length * 0.35)] || 0.2;
    var out = [], perLine = opts.perLine || 8, line = [];
    notes.forEach(function (n) {
      if (opts.hideTransit && n.transit) return;
      var cell = renderSvara(n, opts.marks !== false);
      var extra = commaCount(n, unit);
      for (var e = 0; e < extra; e++) cell += ' ,';
      line.push(cell);
      if (line.length >= perLine) { out.push(line.join('  ')); line = []; }
    });
    if (line.length) out.push(line.join('  '));
    return out.join('\n');
  }

  // ---------- top-level ----------
  function analyzeSamples(x, sr, cfg, onProgress) {
    var track = yinTrack(x, sr, { window: cfg.window, hop: cfg.hop, fmin: cfg.fmin, fmax: cfg.fmax });
    return finishAnalysis(track, cfg);
  }

  function finishAnalysis(track, cfg) {
    var voiced = voicingMask(track, { minConf: cfg.minConf, silenceRatio: cfg.silenceRatio });
    var cents = toCents(track.f0, cfg.tonicHz);
    repairOctaves(cents, voiced);
    cents = medianSmooth(cents, voiced, 1);

    // fill short unvoiced gaps so gamaka isn't chopped
    var maxGap = Math.round(0.09 / (track.hop / track.sr));
    for (var i = 1; i < voiced.length - 1; i++) {
      if (voiced[i]) continue;
      var j = i; while (j < voiced.length && !voiced[j]) j++;
      if (j - i <= maxGap && i > 0 && j < voiced.length && voiced[i - 1] && voiced[j]) {
        for (var k = i; k < j; k++) {
          var t = (k - i + 1) / (j - i + 1);
          cents[k] = cents[i - 1] + (cents[j] - cents[i - 1]) * t;
          voiced[k] = 1;
        }
      }
      i = j;
    }

    var hist = pitchHistogram(cents, voiced, track.conf);
    var ragam = cfg.ragam;
    var positions = ragam.svaras.map(function (s) { return s[0]; });
    var off = tonicOffset(hist, positions, cfg.temperament, 150);
    var suggestions = ragamMatches(hist, cfg.temperament, 5);

    // Two-pass sruthi correction: if the singer's real Sa is measurably offset
    // from the configured tonic, decode against a grid shifted to match the
    // voice. Every downstream svara decision then sees ~zero systematic bias.
    var appliedShift = 0;
    var autoTonic = cfg.autoTonic === undefined ? true : cfg.autoTonic;
    if (autoTonic && Math.abs(off.shift) >= 12) appliedShift = off.shift;

    var lo = Infinity, hi = -Infinity;
    for (i = 0; i < cents.length; i++) if (voiced[i] && isFinite(cents[i])) { if (cents[i] < lo) lo = cents[i]; if (cents[i] > hi) hi = cents[i]; }
    if (!isFinite(lo)) { lo = -1200; hi = 1200; }

    var states = buildStates(ragam, cfg.temperament, lo - appliedShift, hi - appliedShift);
    if (appliedShift) states.forEach(function (st) { st.cents += appliedShift; });

    var path = viterbi(cents, voiced, track.conf, states, {
      sigma: cfg.sigma, switchPenalty: cfg.switchPenalty, silencePenalty: cfg.silencePenalty,
      dirSets: cfg.grammar === false ? null : dirSets(ragam), dirPenalty: cfg.dirPenalty
    });
    var notes = pathToNotes(path, cents, states, track.hop, track.sr,
      { minNoteDur: cfg.minNoteDur, transientMax: cfg.transientMax });

    var meanDev = 0, devN = 0, meanConf = 0;
    notes.forEach(function (n) { meanDev += Math.abs(n.deviation); devN++; meanConf += n.conf; });
    return {
      track: track, cents: cents, voiced: voiced, notes: notes, states: states,
      hist: hist, tonicOffset: off, ragamSuggestions: suggestions,
      appliedShift: appliedShift,
      range: { lo: lo, hi: hi },
      quality: {
        meanAbsDeviation: devN ? meanDev / devN : 0,
        meanNoteConfidence: devN ? meanConf / devN : 0,
        voicedRatio: Array.prototype.reduce.call(voiced, function (a, b) { return a + b; }, 0) / (voiced.length || 1),
        noteCount: notes.length
      }
    };
  }

  var DEFAULTS = { sr: 16000, window: 800, hop: 256, fmin: 70, fmax: 900 };
  function frameCount(len, opts) {
    opts = opts || {};
    var W = opts.window || DEFAULTS.window, hop = opts.hop || DEFAULTS.hop;
    var sr = opts.sr || DEFAULTS.sr, fmin = opts.fmin || DEFAULTS.fmin;
    var tauMax = Math.min(Math.floor(sr / fmin), W - 1);
    return Math.max(0, Math.floor((len - W - tauMax) / hop));
  }

  var API = {
    DEFAULTS: DEFAULTS, frameCount: frameCount,
    RAGAMS: RAGAMS, ET: ET, JI: JI, centsOf: centsOf, dirSets: dirSets,
    TALAS: TALAS, JATHIS: JATHIS, avartanaBeats: avartanaBeats, angaBoundaries: angaBoundaries,
    talaLabel: talaLabel,
    allTalas: allTalas, commaCount: commaCount,
    mixdownResample: mixdownResample, yinTrack: yinTrack, toCents: toCents,
    voicingMask: voicingMask, repairOctaves: repairOctaves, medianSmooth: medianSmooth,
    pitchHistogram: pitchHistogram, tonicOffset: tonicOffset, ragamMatches: ragamMatches,
    buildStates: buildStates, viterbi: viterbi, pathToNotes: pathToNotes,
    renderSvara: renderSvara, notationText: notationText,
    analyzeSamples: analyzeSamples, finishAnalysis: finishAnalysis
  };
  root.SwaraEngine = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
