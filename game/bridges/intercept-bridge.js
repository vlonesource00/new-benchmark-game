import { InterceptDriver } from '../../subjects/intercept/src/driver.js';
import config from '../../subjects/intercept/config.json' with { type: 'json' };
import { interceptState } from './intercept-state.js';

export function createInterceptBridge({hostTrack,index=0,options={},state=null}){
  let driver=null;const settings={...config,...config.tracks?.[hostTrack.id],...options};
  return {driverId:'intercept',candidateId:'intercept',native:true,errors:0,
    get driver(){return driver;},
    update(car,cars,dt,context={}){try{driver??=new InterceptDriver(hostTrack,settings);driver.lastCar=car;driver.contextEpoch=context.epoch??0;
      driver.update(car,cars,dt,{...context,state:context.state??state?.(car)??{}});
      if(!['throttle','brake','steer'].every(k=>Number.isFinite(car.controls[k])))throw new Error('Non-finite INTERCEPT controls');
    }catch(e){this.errors++;this.lastError=String(e.stack??e);car.controls={throttle:0,brake:.6,steer:0};}},
    reset(snapshot){driver??=new InterceptDriver(hostTrack,settings);if(snapshot?.cars?.[index])driver.prepare(snapshot.cars[index]);driver.reset();this.errors=0;},
    debug(){return driver?.debug()??{architecture:'INTERCEPT',intent:'INIT'};},visualDebug(){return driver?.visualDebug()??null;},
    controlPreview(){return driver?.path?driver.controlPreview():null;},dispose(){driver=null;}
  };
}

/** Opt-in host executor: authoritative current pose at 120 Hz, with asynchronous worker plans. */
export function createInterceptExecutor(track,index=0){
  const bridge=createInterceptBridge({hostTrack:track,index,options:{executor:true}});
  return {bridge,adopt(contract,car,epoch){bridge.driver?.prepare(car);return bridge.driver?.adopt(contract,car,epoch)??false;},
    update(car,cars,dt,context){bridge.update(car,cars,dt,context);return car.controls;},
    reset(snapshot){bridge.reset(snapshot);},debug(){return bridge.debug();},visualDebug(){return bridge.visualDebug();}};
}
