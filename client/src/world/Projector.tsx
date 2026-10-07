import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { anchors } from '../lib/anchors';

const v = new THREE.Vector3();

/** Moves every anchored DOM label to the screen position of its 3D point. */
export function Projector() {
  useFrame(({ camera, size }) => {
    for (const a of anchors.values()) {
      const p = a.world();
      let next = 'hidden';
      if (p) {
        v.set(p.x, p.y, p.z).project(camera);
        if (v.z > -1 && v.z < 1) {
          const x = Math.round((v.x * 0.5 + 0.5) * size.width);
          const y = Math.round((-v.y * 0.5 + 0.5) * size.height);
          next = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
        }
      }
      if (next === a.last) continue;
      a.last = next;
      if (next === 'hidden') {
        a.el.style.visibility = 'hidden';
      } else {
        a.el.style.transform = next;
        a.el.style.visibility = 'visible';
      }
    }
  });
  return null;
}
