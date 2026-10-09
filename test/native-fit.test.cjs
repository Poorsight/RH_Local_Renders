"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildRenderPlan}=require('../lib/render-plan.cjs');
const {prepareAdapterJob}=require('../lib/batchrender-adapter.cjs');
function fixture(){return {jobId:'native',_rhLocal:{cameraFitMode:'native'},tasks:[{taskId:'bella',materials:[],sequence:{cameras:[{name:'F',sequenceName:'Leather_Sofa_Indoor_F',fit:'horizontalFocalLength',LayerResolutions:[{Name:'Fabric',Resolution:{X:5000,Y:5000},SensorSize:{X:36,Y:36}},{Name:'Shadow',Resolution:{X:2500,Y:500},SensorSize:{X:180,Y:36}}]}]},layers:[{name:'Fabric',doNotRender:true},{name:'Shadow',doNotRender:false}]}]};}
test('native fit keeps Fabric preparation and Shadow together without external focal transport',()=>{
 const job=fixture(),before=JSON.stringify(job),phases=buildRenderPlan(job);
 assert.equal(JSON.stringify(job),before);assert.equal(phases.length,1);assert.equal(phases[0].useCameraHandoff,false);
 assert.deepEqual(phases[0].job.tasks,job.tasks);
 const adapter=prepareAdapterJob(phases[0].job);assert.deepEqual(adapter.inherited,[]);
 assert.equal(adapter.runtimeJob.tasks[0].sequence.cameras[0].fit,'horizontalFocalLength');
 assert.equal(adapter.runtimeJob.tasks[0].layers[0].doNotRender,true);
});
test('native mode refuses conflicting handoffs, cropped fit frames, missing fit passes and multi-model jobs',()=>{
 const mutations=[j=>j.tasks.push(structuredClone(j.tasks[0])),j=>j.tasks[0].layers[0].doNotRender=false,
 j=>j.tasks[0].sequence.cameras[0].fit='none',j=>j.tasks[0].sequence.cameras[0].Camera={OverrideFocalLength:true,FocalLength:100},
 j=>j.tasks[0].sequence.cameras[0]._rhLocalCrop={},j=>j.tasks[0].sequence.cameras[0].LayerResolutions=[]];
 for(const mutate of mutations){const j=fixture();mutate(j);assert.throws(()=>buildRenderPlan(j),/Native fit/);}
});
