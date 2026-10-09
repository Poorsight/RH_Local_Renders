"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { buildRig, jobLights, sceneKeys, sublevelPrefix } = require("../lib/rig.cjs");
const { buildJob, productType } = require("../lib/jobs.cjs");
const { modelGroup } = require("../lib/models.cjs");
const { parseCsv } = require("../lib/csv.cjs");
const { sequenceToken } = require("../lib/camera-fit.cjs");
const os = require("node:os"), crypto = require("node:crypto");
const row = {active:"TRUE",airtable_categories:"Leather_Sofas",environment:"Indoor",sequence_prefix:"",light_name:"main_key_lgt",light_sublevel_suffix:"KeyLight",camera:"F,P,TQ,TQB",default_x:"-439",default_y:"221",default_z:"155",default_pitch:"1",default_yaw:"335",default_roll:"0",default_intensity:"35",shadow_intensity:"100"};
test("leather category uses the same prefix for sequences and renamed levels", () => {
  assert.deepEqual(sceneKeys(row), ["Leather_Sofa_Indoor"]);
  assert.equal(sublevelPrefix("Leather_Sofa_Indoor"), "Leather_Sofa_Indoor");
  const rig=buildRig([row]);
  assert.equal(jobLights(rig,"Leather_Sofa_Indoor","F")[0].LevelName,"Leather_Sofa_Indoor_KeyLight");
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
  assert.deepEqual(task.layers[0].SubLevels,["Leather_Sofa_Indoor_Background","Leather_Sofa_Indoor_KeyLight"]);
  assert.deepEqual(task.layers[1].SubLevels,["Leather_Sofa_Indoor_Shadow","Leather_Sofa_Indoor_KeyLight"]);
  assert.equal(task.sequence.cameras[0]._rhLocalShadowLights[0].intensity,100);
  for(const camera of task.sequence.cameras) {
    for(const light of [...camera.lights,...camera._rhLocalShadowLights]) assert.equal(light.LevelName,"Leather_Sofa_Indoor_KeyLight");
  }
  assert.ok(!JSON.stringify(task).includes("Sofa_Indoor_Leather"));
});
test("leather lights resolve all three renamed sublevels for product and shadow",()=>{
  const rig=buildRig(["Background","KeyLight","Shadow"].map(suffix=>({...row,light_name:`light_${suffix}`,light_sublevel_suffix:suffix})));
  for(const variant of ["Default","Shadow"]) {
    assert.deepEqual(jobLights(rig,"Leather_Sofa_Indoor","F",variant).map(l=>l.LevelName),["Leather_Sofa_Indoor_Background","Leather_Sofa_Indoor_KeyLight","Leather_Sofa_Indoor_Shadow"]);
  }
  assert.equal(sublevelPrefix("Sectional_Indoor_R"),"Sectional_Indoor");
  assert.equal(sublevelPrefix("Sofa_Indoor"),"Sofa_Indoor");
});
test("camera-fit token tracks the renamed leather sequence folder",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"rh-leather-sequence-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const project=path.join(root,"test.uproject"),name="Leather_Sofa_Indoor_F";
  const current=path.join(root,"Content","Sequences","Leather_Sofa_Indoor",`${name}.uasset`);
  const legacy=path.join(root,"Content","Sequences","Sofa_Indoor_Leather",`${name}.uasset`);
  for(const file of [current,legacy])fs.mkdirSync(path.dirname(file),{recursive:true});
  const hash=value=>crypto.createHash("sha256").update(value).digest("hex").slice(0,16);
  fs.writeFileSync(legacy,"legacy");
  assert.equal(sequenceToken(project,name),hash("legacy"));
  fs.writeFileSync(current,"new");
  assert.equal(sequenceToken(project,name),hash("new"));
  fs.writeFileSync(current,"changed");
  assert.equal(sequenceToken(project,name),hash("changed"));
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
