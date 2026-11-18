const { assertDatabaseSql }=require('../service/database-connection.cjs');
function fixture(fail=false) {
  let live='old',draft,commits=0,releases=0;
  const pool={getConnection:async()=>({
    query:async(sql)=>{
      assertDatabaseSql(sql);
      if(sql.includes('GET_LOCK'))return [[{owned:1}]];
      if(sql.includes('RELEASE_LOCK'))return [[{released:1}]];
      if(sql.startsWith('DELETE'))draft='empty';
      if(sql.trim().startsWith('INSERT')) {if(fail)throw new Error('population failed');draft='next';}
      return [{}];
    },beginTransaction:async()=>{draft=live;},commit:async()=>{commits++;live=draft;},rollback:async()=>{},release(){releases++;},destroy(){}
  })};
  return {pool,state:()=>live,commits:()=>commits,releases:()=>releases};
}
module.exports={fixture};
