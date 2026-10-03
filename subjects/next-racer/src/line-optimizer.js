// SPEARHEAD's line objective includes the time needed to change yaw rate.
// Optimize entry, apex and exit together on the physical Cartesian course;
// local shortest paths and heavily averaged corner peaks are poor proxies.
export function optimizeFlow(base,step,seed,measure,project,options){
  const n=base.length,wrap=i=>(i%n+n)%n;
  let best=new Float32Array(n),state=measure(best),cost=state.cost;
  const accept=q=>{
    project(q);const trial=measure(q);
    if(trial.cost>=cost-1e-6)return false;
    best=q;state=trial;cost=trial.cost;return true;
  };
  for(const scale of [.6,.9,1.1])for(const phase of [-16,0,16]){
    const q=new Float32Array(n),shift=phase/step;
    for(let i=0;i<n;i++){
      const u=wrap(i+shift),j=Math.floor(u),t=u-j;
      q[i]=scale*(seed[j]*(1-t)+seed[wrap(j+1)]*t);
    }
    accept(q);
  }
  // Compact C2 basis functions alter a whole transition without introducing
  // a kink or extending a move into the opposite end of the circuit.
  for(let pass=0;pass<options.optimizerIterations;pass++){
    for(const width of options.optimizerWidths){
      const reach=Math.ceil(width/step),amplitude=(width>=55?.8:width>=25?.45:.2)*(.92**pass);
      for(let bin=0;bin<options.optimizerBins;bin++){
        const center=Math.round((bin+(pass%3)/3)*n/options.optimizerBins);
        for(const sign of [-1,1]){
          const q=new Float32Array(best);
          for(let j=-reach;j<=reach;j++){
            const t=j/reach,bell=Math.max(0,1-t*t)**3;
            q[wrap(center+j)]+=sign*amplitude*bell;
          }
          accept(q);
        }
      }
    }
  }
  return {q:best,geometry:state.geometry,estimatedLapTime:state.time};
}
