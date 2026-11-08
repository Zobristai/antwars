import assert from 'node:assert/strict';
import { rulesConfig, speedPerTick } from '../../src/sim/config.js';
import { newMatchConfig } from '../../src/sim/gridScale.js';
import { createMatch, newAnt } from '../../src/sim/map.js';
import { assignPointRests } from '../../src/sim/pointSlots.js';
import { beginLocalGoals, notePoint, type LocalGoal } from '../../src/sim/localArrival.js';
import { advanceSoftAnts } from '../../src/sim/step.js';
import { isPassable } from '../../src/sim/terrain.js';
import { sevenMapRotation } from './seven-map-rotation.js';
export function checkPointCapacity(mapId: string): void {
 const base=rulesConfig('redesign'), variant=base.pointArrival!.variant;
 // Pinned to the seven-map rotation this was written for, which holds the old two.
 const config=sevenMapRotation(newMatchConfig({...base,startAnts:0,terrain:{...base.terrain!,mapId}}));
 const state=createMatch(7004,config);state.ants=[];const home=state.colonies[0];
 for(let i=0;i<4096;i++)state.ants.push(newAnt(config,state.nextAntId++,0,home.queenX,home.queenY,i%2?'worker':'soldier'));
 const goals=new Map(state.ants.map(ant=>[ant.id,{key:'point',kind:'point',x:64500,y:48500,nativeReached:false} as LocalGoal]));
 const started=performance.now();const assigned=assignPointRests(state,goals);
 assert.equal(assigned.size,4096);assert.equal(new Set([...assigned.values()].map(p=>p.x+','+p.y)).size,4096);
 console.log(variant+'/'+mapId+': assigned4096 in '+(performance.now()-started)+'ms');
 let phases=0,maxStepSquared=0;
 for(;phases<1200;phases++){
  beginLocalGoals(state);for(const ant of state.ants)notePoint(state,ant,64500,48500);
  const frame=advanceSoftAnts(state,new Map(),new Set());state.tick++;
  for(const ant of state.ants){const origin=frame.origins.get(ant.id)!;maxStepSquared=Math.max(maxStepSquared,(ant.x-origin.x)**2+(ant.y-origin.y)**2);}
  if(state.ants.every(ant=>ant.x===ant.pointRest!.x&&ant.y===ant.pointRest!.y))break;
 }
 const unfinished=state.ants.filter(ant=>ant.x!==ant.pointRest!.x||ant.y!==ant.pointRest!.y);
 console.log(JSON.stringify({variant,mapId,resting:4096-unfinished.length,phases:phases+1,seconds:(performance.now()-started)/1000,unfinished:unfinished.slice(0,5).map(ant=>({id:ant.id,x:ant.x,y:ant.y,rest:ant.pointRest}))}));
 assert.equal(unfinished.length,0);assert.ok(maxStepSquared<=speedPerTick(config)**2);
 for(const ant of state.ants)assert.ok(isPassable(state,Math.floor(ant.x/1000),Math.floor(ant.y/1000)));
}
