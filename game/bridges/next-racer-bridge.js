import { SpearheadDriver } from '../../subjects/next-racer/src/driver.js';
import config from '../../subjects/next-racer/config.json' with {type:'json'};

export function createNextRacerBridge({hostTrack,index=0,options={},state=null}) {
  const settings={...config,...options,path:{...config.path,...options.path},
    policy:{...config.policy,...options.policy}};
  let driver=null;
  return {driverId:'next-racer',candidateId:'next-racer',native:true,errors:0,
    get driver(){return driver;},
    update(car,cars,dt,context={}) {
      try {
        driver??=new SpearheadDriver(hostTrack,settings);
        driver.update(car,cars,dt,{...context,state:context.state??state?.(car)??{}});
        if(!['throttle','brake','steer'].every(k=>Number.isFinite(car.controls[k])))throw new Error('Non-finite controls');
      }catch(error){this.errors++;this.lastError=String(error?.stack??error);car.controls={throttle:0,brake:.6,steer:0};}
    },
    reset(snapshot) {
      driver??=new SpearheadDriver(hostTrack,settings);
      if(snapshot?.cars?.[index])driver.prepare(snapshot.cars[index],snapshot.cars.length);
      driver.reset();this.errors=0;this.lastError=null;
    },
    debug(){return driver?.debug()??{architecture:'SPEARHEAD',intent:'INIT'};},
    controlPreview(){return driver?.controlPreview()??null;},
    visualDebug(){return {trackingPoint:driver?.trackingPoint??hostTrack.at(hostTrack.gridS)};},
    dispose(){driver=null;}
  };
}
