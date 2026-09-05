import { TABLES, num, bool, json, ts, looksLikeHeader } from './migrate.js';
let fail=0;
const eq=(a,b,l)=>{const A=JSON.stringify(a),B=JSON.stringify(b);
  if(A!==B){console.log(`❌ ${l}\n   kapott: ${A}\n   várt:   ${B}`);fail++;}else console.log(`✅ ${l}`);};

// --- konverterek ---
eq(num('3,67'),3.67,'magyar tizedesvessző');
eq(num('4.5'),4.5,'pont is jó');
eq(num(''),0,'üres -> 0');
eq(num('abc'),0,'szemét -> 0');
eq(bool('TRUE'),true,'TRUE -> true');
eq(bool('false'),false,'false -> false');
eq(bool(undefined),false,'undefined -> false');
eq(json('{"unlocked":["a"]}',{}),{unlocked:['a']},'JSON parse');
eq(json('{rossz',{x:1}),{x:1},'hibás JSON -> fallback');
eq(ts('2026-09-05 12:34:56'),'2026-09-05T12:34:56.000Z','Sheets dátum -> UTC');
eq(ts(''),null,'üres dátum -> null');
eq(looksLikeHeader(['Dátum','Név','Sör neve']),true,'fejléc felismerés');
eq(looksLikeHeader(['2026-09-05','Béla','IPA']),false,'adatsor nem fejléc');

// --- users leképezés (A–O, valós sorrend) ---
const U=TABLES.find(t=>t.table==='users');
const urow=['Béla','b@x.hu','$2a$10$hash','enc:v1:abc','TRUE','{"unlocked":["first"]}','🍺',
            '$2a$10$rec','2026-W05','3','7','gid123','[{"date":"2026-01-01"}]','FALSE','{"public":true}'];
const u=U.map(urow);
eq(u.email,'b@x.hu','users.email');
eq(u.twofa_enabled,true,'users.twofa_enabled boolean');
eq(u.achievements,{unlocked:['first']},'users.achievements jsonb');
eq(u.current_streak,3,'users.current_streak');
eq(u.longest_streak,7,'users.longest_streak');
eq(u.is_banned,false,'users.is_banned');
eq(u.settings,{public:true},'users.settings jsonb');
eq(u.password_hash,'$2a$10$hash','users jelszó hash érintetlen');
eq(U.isData(urow),true,'users.isData valódi sorra');
eq(U.isData(['Név','Email','Jelszó']),false,'users.isData fejlécre');

// --- user_beers (A–O) ---
const B=TABLES.find(t=>t.table==='user_beers');
const b=B.map(['2026-09-05 10:00:00','Béla','Soproni','Sopron','Lager',
               '4','5','6','5,2','15','5,00','jó','Nem','b@x.hu','uid-1']);
eq(b.beer_name,'Soproni','beers.beer_name');
eq(b.beer_percentage,5.2,'beers.abv (I oszlop)');
eq(b.total_score,15,'beers.total_score (J oszlop)');
eq(b.avg,5,'beers.avg vesszőből (K oszlop)');
eq(b.user_email,'b@x.hu','beers.user_email (N oszlop)');
eq(b.beer_uid,'uid-1','beers.beer_uid (O oszlop)');

// --- user_drinks (A–N) ---
const D=TABLES.find(t=>t.table==='user_drinks');
const d=D.map(['2026-09-05 10:00:00','Béla','Unicum','Likőr','Keserű','Bp',
               '40','3','4','5','12','4,00','ok','b@x.hu']);
eq(d.drink_name,'Unicum','drinks.drink_name');
eq(d.drink_percentage,40,'drinks.abv (G oszlop)');
eq(d.avg,4,'drinks.avg (L oszlop)');
eq(d.user_email,'b@x.hu','drinks.user_email (N oszlop)');

// --- admin_beers: EGY sor -> KÉT rekord ---
const A=TABLES.find(t=>t.table==='admin_beers');
const arow=new Array(22).fill('');
arow[0]='Sör1'; arow[1]='Pécs'; arow[2]='IPA'; arow[6]='18'; arow[7]='6,00'; arow[8]='5,5'; arow[9]='2026-01-01';
arow[12]='Sör2'; arow[13]='Eger'; arow[14]='Stout'; arow[18]='21'; arow[19]='7,00';
const ab=A.expand(arow,0);
eq(ab.length,2,'admin: egy sorból két rekord');
eq(ab[0].rated_by,'admin1','admin1 címke');
eq(ab[0].avg,6,'admin1 avg vesszőből');
eq(ab[0].beer_percentage,5.5,'admin1 abv');
eq(ab[1].rated_by,'admin2','admin2 címke');
eq(ab[1].beer_name,'Sör2','admin2 név (M oszlop)');
const half=new Array(22).fill(''); half[0]='CsakEgy';
eq(A.expand(half,0).length,1,'admin: üres második értékelő kimarad');

// --- ideas / recommendations / beerpong ---
const I=TABLES.find(t=>t.table==='ideas');
const i=I.map(['Béla','Legyen sötét mód','10:00','Kész','2026-09-05','b@x.hu','5','["a@x.hu"]']);
eq(i.idea_text,'Legyen sötét mód','ideas.idea_text'); eq(i.vote_count,5,'ideas.vote_count');
eq(i.voters,['a@x.hu'],'ideas.voters jsonb');

const R=TABLES.find(t=>t.table==='recommendations');
const r=R.map(['2026-09-05 10:00:00','Béla','b@x.hu','Tétel','sör','leírás','TRUE','Egyéb','FALSE','2','["c@x.hu"]']);
eq(r.is_anonymous,true,'rec.is_anonymous'); eq(r.is_edited,false,'rec.is_edited');
eq(r.vote_count,2,'rec.vote_count'); eq(r.voters,['c@x.hu'],'rec.voters');

const P=TABLES.find(t=>t.table==='beerpong_records');
const p=P.map(['b@x.hu','match','rec-1','2026-09-05','{"score":[10,7]}']);
eq(p.payload,{score:[10,7]},'beerpong.payload jsonb');
eq(P.isData(['b@x.hu','match','rec-1']),true,'beerpong.isData');
eq(P.isData(['','','']),false,'beerpong.isData üresre');

const C=TABLES.find(t=>t.table==='consumptions');
const c=C.map(['2026-09-05 10:00:00','b@x.hu','Soproni','uid-1','2','5','10','5,2']);
eq(c.total_dl,10,'consumption.total_dl'); eq(c.abv,5.2,'consumption.abv');

const W=TABLES.find(t=>t.table==='winners');
eq(W.map(['2026','Béla','b@x.hu','nyeremény']).row_data,['2026','Béla','b@x.hu','nyeremény'],'winners nyers sor');

console.log(fail? `\n💥 ${fail} teszt bukott` : '\n🎉 Mind a 53 ellenőrzés átment');
process.exit(fail?1:0);
