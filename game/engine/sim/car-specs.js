// Astra physics presets in SI units. Touring/prototype dimensions and power
// targets are adapted from the sibling GPT Racing class catalogue; the GT
// preserves Astra's validated A1 specification. All drivers use these forces.
const gt={key:'gt',label:'GT',drive:'rear',mass:1290,wheelbase:2.78,track:1.72,cg:.43,frontWeight:.47,yawInertia:2030,radius:.335,wheelInertia:1.9,maxTorque:575,gears:[0,3.05,2.12,1.62,1.29,1.06,.88],finalDrive:3.8,steeringLock:.48,area:1.9,cd:.64,cl:2.25,brakeTorque:6200,brakeBias:.58,tyreGrip:1,frontAero:.43,springFront:72000,springRear:81000,halfWidth:.99,halfLength:2.3};
const freeze=s=>Object.freeze({...s,gears:Object.freeze([...s.gears])});
export const CAR_CLASSES=Object.freeze({
  gt:freeze(gt),
  touring:freeze({...gt,key:'touring',label:'TOURING',drive:'front',mass:1390,wheelbase:2.72,track:1.59,cg:.53,frontWeight:.61,yawInertia:2240,maxTorque:395,gears:[0,3.34,2.13,1.48,1.13,.91,.76],finalDrive:3.72,area:2.06,cd:.58,cl:.81,brakeTorque:5900,brakeBias:.64,tyreGrip:.88,frontAero:.43,springFront:54500,springRear:50000}),
  // LMDh / GTP hybrid prototype (game class). Read from the 2023+ LMDh rules: 1030 kg
  // minimum, 3.15 m maximum wheelbase, 2.0 m wide, ~500 kW combined with a spec 50 kW
  // rear-axle MGU (deployed by core/hybrid.js, not here), carbon brakes and a
  // downforce-to-drag ratio near 4. Values are tuned to stay drivable on a keyboard.
  lmdh:freeze({...gt,key:'lmdh',label:'GTP',mass:1030,wheelbase:3.1,track:1.72,cg:.36,frontWeight:.46,yawInertia:1900,radius:.355,wheelInertia:2.1,maxTorque:720,gears:[0,3.0,2.14,1.66,1.34,1.11,.94,.81],finalDrive:3.6,steeringLock:.5,area:1.6,cd:.82,cl:4.3,brakeTorque:7400,brakeBias:.58,tyreGrip:1.08,tyreWear:.8,frontAero:.43,springFront:90000,springRear:98000,halfWidth:1.0,halfLength:2.55}),
  prototype:freeze({...gt,key:'prototype',label:'PROTOTYPE',mass:925,wheelbase:2.62,track:1.72,cg:.38,frontWeight:.48,yawInertia:1480,maxTorque:665,gears:[0,3.04,2.17,1.65,1.31,1.08,.91],finalDrive:3.72,steeringLock:.55,area:1.52,cd:.81,cl:4.84,brakeTorque:7000,brakeBias:.59,tyreGrip:1.10,frontAero:.485,springFront:79000,springRear:86000})
});
export const CLASS_IDS=Object.freeze(Object.keys(CAR_CLASSES));
export const carSpecFor=id=>CAR_CLASSES[id]??CAR_CLASSES.gt;
