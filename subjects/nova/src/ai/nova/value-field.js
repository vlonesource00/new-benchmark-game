import { angle } from '../../sim/math.js';

export class NovaValueField {
    /**
     * @param {Object} deps Dependencies
     * @param {Object} deps.reference The reference nominal trajectory
     * @param {Object} deps.envelope Physical limits envelope
     * @param {Object} deps.model Track/vehicle model
     */
    constructor({ reference, envelope, model } = {}) {
        this.reference = reference;
        this.envelope = envelope;
        this.model = model;

        // Precompute cumulative remaining lap time V0 if reference has parallel arrays
        if (this.reference && this.reference.v && this.reference.n) {
            const n = this.reference.n;
            const ds = this.reference.ds || (this.reference.length / n);
            this.V0 = new Float64Array(n);
            let accum = 0;
            for (let i = n - 1; i >= 0; i--) {
                const vi = Math.max(3.0, this.reference.v[i]);
                accum += ds / vi;
                this.V0[i] = accum;
            }
            this.nominalLapTime = accum;
        }
    }

    /**
     * Retrieves interpolated nominal trajectory parameters at station s.
     * @param {number} s Station
     * @returns {Object} { s, q, v, kappa, heading, V0 }
     */
    sampleNominal(s) {
        const ref = this.reference;
        // 1. Parallel typed-array reference (e.g. NOVA_FREE_AIR)
        if (ref && ref.n && ref.v) {
            const length = ref.length || (ref.n * (ref.ds || 1.25));
            const ds = ref.ds || (length / ref.n);
            const normS = ((s % length) + length) % length;
            const x = normS / ds;
            const i = Math.floor(x) % ref.n;
            const j = (i + 1) % ref.n;
            const t = x - Math.floor(x);

            const v = ref.v[i] + (ref.v[j] - ref.v[i]) * t;
            const q = ref.q ? (ref.q[i] + (ref.q[j] - ref.q[i]) * t) : 0;
            const kappa = ref.kappa ? (ref.kappa[i] + (ref.kappa[j] - ref.kappa[i]) * t) : 0;
            const heading = ref.heading ? (ref.heading[i] + angle(ref.heading[j] - ref.heading[i]) * t) : 0;
            const v0_i = this.V0 ? this.V0[i] : Math.max(0, (length - normS) / Math.max(5.0, v));
            const v0_j = (this.V0 && j === 0) ? 0 : (this.V0 ? this.V0[j] : 0);
            const V0 = this.V0 ? Math.max(0, v0_i + (v0_j - v0_i) * t) : Math.max(0, (length - normS) / Math.max(5.0, v));

            return { s: normS, q, v, kappa, heading, V0 };
        }

        // 2. Linear interpolation if reference is an array of points
        if (ref && Array.isArray(ref) && ref.length > 0) {
            const points = ref;
            if (s <= points[0].s) return { ...points[0] };
            if (s >= points[points.length - 1].s) return { ...points[points.length - 1] };
            
            let idx = 0;
            while (idx < points.length - 1 && points[idx+1].s < s) {
                idx++;
            }
            const p1 = points[idx];
            const p2 = points[idx+1];
            
            const t = (p2.s !== p1.s) ? (s - p1.s) / (p2.s - p1.s) : 0;
            
            return {
                s: s,
                q: p1.q + t * (p2.q - p1.q),
                v: p1.v + t * (p2.v - p1.v),
                kappa: p1.kappa + t * (p2.kappa - p1.kappa),
                heading: p1.heading + angle(p2.heading - p1.heading) * t,
                V0: (p1.V0 ?? 0) + t * ((p2.V0 ?? 0) - (p1.V0 ?? 0))
            };
        }
        
        // Fallback analytical track mock for tests without reference
        const trackLength = 5000; 
        const remainingS = Math.max(0, trackLength - s);
        return {
            s: s,
            q: 0.0,
            v: 50.0,
            kappa: 0.005 * Math.sin(s / 100),
            heading: s / 100,
            V0: remainingS / 50.0
        };
    }


    /**
     * Evaluates the Taylor/Riccati sensitivity approximation around nominal.
     * @param {number} s Station
     * @param {number} q Lateral displacement
     * @param {number} v Speed
     * @param {number} e_psi Heading error
     * @returns {number} Estimated remaining lap time in seconds
     */
    evaluate(s, q, v, e_psi) {
        const nom = this.sampleNominal(s);
        const dq = q - nom.q;
        const dv = v - nom.v;
        
        // V0: Base nominal remaining time
        let V = nom.V0;
        
        // 1. Speed penalty (dv)
        // dV/dv ~= -1.0 / max(5.0, v*(s)) - deficit directly costs time
        const dV_dv = -1.0 / Math.max(5.0, nom.v);
        const H_vv = 0.01 / Math.max(5.0, nom.v); 
        V += dV_dv * dv + 0.5 * H_vv * dv * dv;
        
        // 2. Spatial penalty (dq)
        // Near nominal line, dV/dq is small, but increases quadratically as |dq| grows.
        const dV_dq = 0.005 * dq; 
        // Spatial penalty weight scaled by local curvature kappa (off-line in corner is expensive)
        const H_qq = 0.05 + 3.0 * Math.abs(nom.kappa);
        V += dV_dq * dq + 0.5 * H_qq * dq * dq;
        
        // 3. Heading misalignment penalty (e_psi)
        // Misalignment costs scrubbing & delayed acceleration: ~ 0.25 * e_psi^2
        V += 0.25 * e_psi * e_psi;
        
        return Math.max(0, V);
    }

    /**
     * Helper alias for evaluating value from a state object.
     * @param {Object} state - Object containing { s, q, v, epsi/ehead }
     * @returns {number}
     */
    getValue(state) {
        if (!state) return 0;
        const s = state.s ?? state.station ?? 0;
        const q = state.q ?? state.lateral ?? 0;
        const v = state.v ?? state.speed ?? 0;
        const e_psi = state.e_psi ?? state.epsi ?? state.ehead ?? state.headingError ?? state.yawError ?? 0;
        return this.evaluate(s, q, v, e_psi);
    }

    /**
     * Returns the gradient of the value field V* with respect to state variables.
     * @param {number} s Station
     * @param {number} q Lateral displacement
     * @param {number} v Speed
     * @param {number} e_psi Heading error
     * @returns {Object} { dV_ds, dV_dq, dV_dv, dV_depsi }
     */
    gradient(s, q, v, e_psi) {
        const nom = this.sampleNominal(s);
        const dq = q - nom.q;
        const dv = v - nom.v;
        
        // dV/ds: Nominal change in remaining time per meter advanced
        const dV_ds = -1.0 / Math.max(1.0, nom.v); 
        
        // dV/dq: Derivative of the spatial penalty
        const H_qq = 0.05 + 3.0 * Math.abs(nom.kappa);
        const dV_dq = (0.005 * 2 * dq) + H_qq * dq; 
        
        // dV/dv: Derivative of the speed penalty
        const H_vv = 0.01 / Math.max(5.0, nom.v);
        const dV_dv = -1.0 / Math.max(5.0, nom.v) + H_vv * dv;
        
        // dV/depsi: Derivative of the heading penalty
        const dV_depsi = 0.5 * e_psi;
        
        return { dV_ds, dV_dq, dV_dv, dV_depsi };
    }

    /**
     * Determines optimal downstream lateral position q_target.
     * Naturally allows the car to exploit being wide rather than forcing a snap back.
     * @param {number} s Station
     * @param {number} q Current lateral displacement
     * @param {number} lookaheadDist Lookahead distance (meters)
     * @returns {number} Target lateral position q_target
     */
    optimalContinuationQ(s, q, lookaheadDist) {
        const futureS = s + lookaheadDist;
        const nomCurrent = this.sampleNominal(s);
        const nomFuture = this.sampleNominal(futureS);
        
        const dq = q - nomCurrent.q;
        
        // Exponential decay of the deviation based on track curvature.
        // On straights (kappa ~ 0), it slowly drifts back. In corners, it snaps back faster.
        const kappaAvg = (Math.abs(nomCurrent.kappa) + Math.abs(nomFuture.kappa)) / 2.0;
        const decay = Math.exp(-lookaheadDist * (0.005 + 0.5 * kappaAvg));
        
        return nomFuture.q + dq * decay;
    }
}

export function createValueField(deps) {
    return new NovaValueField(deps);
}
