"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { buildRig, jobLights, sceneKeys, sublevelPrefix } = require("../lib/rig.cjs");
const { buildJob, productType } = require("../lib/jobs.cjs");
const { modelGroup } = require("../lib/models.cjs");
const { parseCsv } = require("../lib/csv.cjs");
const row = {active:"TRUE",airtable_categories:"Leather_Sofas",environment:"Indoor",sequence_prefix:"",light_name:"main_key_lgt",light_sublevel_suffix:"KeyLight",camera:"F,P,TQ,TQB",default_x:"-439",default_y:"221",default_z:"155",default_pitch:"1",default_yaw:"335",default_roll:"0",default_intensity:"35",shadow_intensity:"100"};
test("leather category uses its own sequence and level prefixes", () => {
  assert.deepEqual(sceneKeys(row), ["Leather_Sofa_Indoor"]);
  assert.equal(sublevelPrefix("Leather_Sofa_Indoor"), "Sofa_Indoor_Leather");
  const rig=buildRig([row]);
  assert.equal(jobLights(rig,"Leather_Sofa_Indoor","F")[0].LevelName,"Sofa_Indoor_Leather_KeyLight");
  assert.equal(jobLights(rig,"Leather_Sofa_Indoor","F","Shadow")[0].intensity,100);
  assert.equal(jobLights(rig,"Leather_Sofa_Indoor","F")[0].intensity,35);
  assert.throws(()=>jobLights(buildRig([{...row,light_sublevel_suffix:""}]),"Leather_Sofa_Indoor","F"),/light_sublevel_suffix/);
});
test("leather job uses dedicated sequences without the fabric blocker", () => {
  const input={productType:"Leather_Sofas",dimensions:{width:270,depth:110,height:80},cameras:["F","P","TQ","TQB","FH"],layers:["Fabric","Shadow"],materials:[{meshes:["UPH"],material:"CAVALLINO_LEATHER_IVORY_V1"}]};
  const model={name:"BELLA_LEATHER_TEST",path:"D:/models/test.obj",offsetUniformScale:1,group:"leather_sofas"};
  const job=buildJob(input,model,buildRig([row]),"D:/renders/test"),task=job.tasks[0];
  assert.equal(job._rhLocal.productType,"leather_sofas");
  assert.deepEqual(task.sequence.cameras.map(c=>c.sequenceName),["Leather_Sofa_Indoor_F","Leather_Sofa_Indoor_P","Leather_Sofa_Indoor_TQ","Leather_Sofa_Indoor_TQB"]);
  assert.deepEqual(task.sequence.cameras.map(c=>c.Actor.Rotation.Yaw),[0,90,30,150]);
  assert.ok(task.sequence.cameras.every(c=>c.Actor.Rotation.Roll===0&&c.SceneActors.length===0));
  assert.deepEqual(task.layers[0].SubLevels,["Sofa_Indoor_Leather_Background","Sofa_Indoor_Leather_KeyLight"]);
  assert.deepEqual(task.layers[1].SubLevels,["Sofa_Indoor_Leather_Shadow","Sofa_Indoor_Leather_KeyLight"]);
  assert.equal(task.sequence.cameras[0]._rhLocalShadowLights[0].intensity,100);
});
test("leather models stay in sofas folder but are classified separately",()=>{
  const root=path.resolve("models");
  assert.equal(modelGroup(root,path.join(root,"sofas","BELLA_LEATHER_TWO_SEAT.obj")),"leather_sofas");
  assert.equal(modelGroup(root,path.join(root,"sofas","BELLA_TWO_SEAT.obj")),"sofas");
  assert.equal(modelGroup(root,path.join(root,"sectionals","BELLA_LEATHER_SECTIONAL.fbx")),"sectionals");
});
test("adding leather rows does not change existing rigs or product profiles",()=>{
  const rows=parseCsv(fs.readFileSync(path.join(__dirname,"../data/sectionals-indoor.csv"),"utf8"));
  const before=buildRig(rows),after=buildRig([...rows,row]);
  for(const [name,value] of Object.entries(before))assert.deepEqual(after[name],value);
  assert.equal(productType("sofas").scene(),"Sofa_Indoor");
  assert.equal(productType("sectionals").scene("R"),"Sectional_Indoor_R");
});
