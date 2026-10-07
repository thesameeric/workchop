import { memo } from 'react';
import { getEntry } from '../../../shared/catalog';
import { shade } from '../lib/color';
import { Ball, Box, Cyl } from './prims';

// Furniture built from primitives. Every model is centred on its footprint,
// sits on y = 0 and faces +z (the side a person uses it from).

const METAL = '#5b5f66';
const DARK = '#2d2f36';

function Desk({ c }: { c: string }) {
  return (
    <group>
      <Box p={[0, 0.6, 0]} s={[2, 0.05, 0.95]} c={c} />
      {[-0.92, 0.92].map((x) => (
        <Box key={x} p={[x, 0.3, 0]} s={[0.06, 0.58, 0.85]} c={METAL} />
      ))}
      <Box p={[0, 0.4, -0.42]} s={[1.8, 0.3, 0.02]} c={shade(c, -0.15)} />
      {/* Monitor */}
      <Box p={[0, 0.66, -0.28]} s={[0.26, 0.02, 0.16]} c={DARK} />
      <Box p={[0, 0.76, -0.3]} s={[0.05, 0.2, 0.04]} c={DARK} />
      <Box p={[0, 0.98, -0.3]} s={[0.86, 0.48, 0.04]} c="#1d1f24" />
      <Box p={[0, 0.98, -0.277]} s={[0.8, 0.42, 0.005]} c="#3a5fd9" emissive="#3a5fd9" emissiveIntensity={0.55} shadow={false} />
      <Box p={[0, 0.635, 0.05]} s={[0.5, 0.02, 0.15]} c="#e8e8ee" />
      <Box p={[0.38, 0.632, 0.07]} s={[0.08, 0.015, 0.12]} c="#e8e8ee" />
      <Cyl p={[-0.7, 0.675, 0.05]} rad={0.045} h={0.1} c="#ef476f" />
    </group>
  );
}

function Chair({ c }: { c: string }) {
  return (
    <group>
      <Cyl p={[0, 0.03, 0]} rad={0.26} h={0.04} c={DARK} />
      <Cyl p={[0, 0.18, 0]} rad={0.03} h={0.28} c={METAL} />
      <Box p={[0, 0.36, 0]} s={[0.48, 0.08, 0.46]} c={c} rounded />
      <Box p={[0, 0.66, -0.22]} s={[0.46, 0.5, 0.07]} c={c} rounded />
      <Box p={[0, 0.42, -0.19]} s={[0.04, 0.12, 0.04]} c={METAL} />
    </group>
  );
}

function Stool({ c }: { c: string }) {
  return (
    <group>
      <Cyl p={[0, 0.02, 0]} rad={0.2} h={0.03} c={METAL} />
      <Cyl p={[0, 0.2, 0]} rad={0.03} h={0.36} c={METAL} />
      <Cyl p={[0, 0.4, 0]} rad={0.22} h={0.07} c={c} />
    </group>
  );
}

function Armchair({ c, width = 1 }: { c: string; width?: number }) {
  const inner = width - 0.3;
  const cushions = width > 1 ? [-inner / 4, inner / 4] : [0];
  // The seat is shallow enough for a seated character's legs to hang over the front edge.
  return (
    <group>
      <Box p={[0, 0.17, -0.1]} s={[width - 0.05, 0.24, 0.65]} c={shade(c, -0.12)} rounded />
      {cushions.map((x) => (
        <Box key={x} p={[x, 0.34, 0]} s={[inner / cushions.length - 0.02, 0.12, 0.44]} c={c} rounded />
      ))}
      <Box p={[0, 0.55, -0.32]} s={[width - 0.05, 0.6, 0.2]} c={c} rounded />
      {[-1, 1].map((sx) => (
        <Box key={sx} p={[sx * (width / 2 - 0.1), 0.38, -0.1]} s={[0.17, 0.42, 0.65]} c={shade(c, -0.05)} rounded />
      ))}
      {[-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) => <Box key={`${sx}${sz}`} p={[sx * (width / 2 - 0.12), 0.03, -0.1 + sz * 0.25]} s={[0.06, 0.06, 0.06]} c={DARK} />),
      )}
    </group>
  );
}

function Beanbag({ c }: { c: string }) {
  return (
    <group>
      <Ball p={[0, 0.2, 0]} s={[0.44, 0.24, 0.44]} c={c} />
      <Ball p={[0, 0.34, -0.2]} s={[0.36, 0.26, 0.2]} c={c} />
    </group>
  );
}

function CoffeeTable({ c }: { c: string }) {
  return (
    <group>
      <Box p={[0, 0.32, 0]} s={[1.6, 0.05, 0.75]} c={c} rounded />
      {[-0.7, 0.7].flatMap((x) => [-0.3, 0.3].map((z) => <Box key={`${x}${z}`} p={[x, 0.15, z]} s={[0.05, 0.3, 0.05]} c={DARK} />))}
      <Box p={[-0.3, 0.36, 0.05]} s={[0.3, 0.03, 0.22]} c="#4361ee" />
      <Box p={[-0.28, 0.385, 0.06]} s={[0.28, 0.02, 0.2]} c="#ffca3a" />
      <Cyl p={[0.4, 0.4, -0.05]} rad={0.05} h={0.1} c="#f2f2f2" />
    </group>
  );
}

function RoundTable({ c }: { c: string }) {
  return (
    <group>
      <Cyl p={[0, 0.02, 0]} rad={0.25} h={0.03} c={DARK} />
      <Cyl p={[0, 0.3, 0]} rad={0.035} h={0.58} c={METAL} />
      <Cyl p={[0, 0.6, 0]} rad={0.4} h={0.04} c={c} seg={32} />
      <Cyl p={[0.1, 0.66, 0.05]} rad={0.04} h={0.08} c="#6d4c41" />
    </group>
  );
}

function MeetingTable({ c }: { c: string }) {
  return (
    <group>
      <Box p={[0, 0.6, 0]} s={[3.8, 0.06, 1.7]} c={c} rounded />
      {[-1.3, 1.3].map((x) => (
        <Box key={x} p={[x, 0.29, 0]} s={[0.25, 0.58, 0.9]} c={DARK} />
      ))}
      <Cyl p={[0, 0.65, 0]} rad={0.13} h={0.04} c="#1d1f24" />
      <Box p={[-1, 0.64, 0.45]} s={[0.4, 0.02, 0.28]} c="#c9ced6" metalness={0.5} roughness={0.4} />
      <Box p={[1.1, 0.64, -0.4]} s={[0.4, 0.02, 0.28]} c="#c9ced6" metalness={0.5} roughness={0.4} />
      <Cyl p={[0.6, 0.67, 0.5]} rad={0.04} h={0.1} c="#2a9d8f" />
    </group>
  );
}

function Reception({ c }: { c: string }) {
  return (
    <group>
      <Box p={[0, 0.45, 0]} s={[3, 0.9, 0.9]} c={c} rounded />
      <Box p={[0, 0.92, 0]} s={[3.1, 0.05, 1]} c="#c8a27a" />
      <Box p={[0, 0.55, -0.455]} s={[3.02, 0.12, 0.02]} c="#4361ee" emissive="#4361ee" emissiveIntensity={0.4} />
      <Box p={[0.6, 1.17, 0.1]} s={[0.7, 0.4, 0.04]} c="#1d1f24" />
      <Box p={[0.6, 1.17, 0.123]} s={[0.64, 0.34, 0.005]} c="#3a5fd9" emissive="#3a5fd9" emissiveIntensity={0.55} shadow={false} />
      <Ball p={[-1.1, 1.02, 0]} rad={0.06} c="#ffd166" metalness={0.6} roughness={0.3} />
    </group>
  );
}

function Whiteboard() {
  const strokes: [number, number, number, string][] = [
    [-0.45, 1.5, 0.6, '#4361ee'],
    [-0.35, 1.38, 0.4, '#4361ee'],
    [0.35, 1.45, 0.5, '#ef476f'],
    [-0.2, 1.15, 0.9, '#2a9d8f'],
    [0.4, 1.02, 0.3, '#2a9d8f'],
  ];
  return (
    <group>
      {[-0.92, 0.92].map((x) => (
        <group key={x}>
          <Box p={[x, 0.02, 0]} s={[0.06, 0.04, 0.45]} c={METAL} />
          <Box p={[x, 0.6, 0]} s={[0.04, 1.2, 0.04]} c={METAL} />
        </group>
      ))}
      <Box p={[0, 1.3, -0.01]} s={[1.96, 1.14, 0.03]} c="#b9bec7" />
      <Box p={[0, 1.3, 0.01]} s={[1.88, 1.06, 0.02]} c="#fbfbfd" roughness={0.3} />
      {strokes.map(([x, y, w, col], i) => (
        <Box key={i} p={[x, y, 0.022]} s={[w, 0.025, 0.004]} c={col} shadow={false} />
      ))}
      <Box p={[0, 0.76, 0.04]} s={[1.2, 0.03, 0.08]} c="#b9bec7" />
    </group>
  );
}

function Tv() {
  return (
    <group>
      <Box p={[0, 0.02, 0]} s={[0.6, 0.04, 0.35]} c={DARK} />
      <Box p={[0, 0.55, -0.05]} s={[0.08, 1.05, 0.06]} c={DARK} />
      <Box p={[0, 1.15, 0]} s={[1.8, 1, 0.06]} c="#111216" />
      <Box p={[0, 1.15, 0.031]} s={[1.72, 0.92, 0.005]} c="#24305e" emissive="#24305e" emissiveIntensity={0.7} shadow={false} />
      <Box p={[-0.35, 1.38, 0.035]} s={[0.8, 0.1, 0.004]} c="#ffffff" emissive="#ffffff" emissiveIntensity={0.6} shadow={false} />
      {[0, 1, 2, 3].map((i) => (
        <Box key={i} p={[-0.55 + i * 0.32, 0.95 + i * 0.05, 0.035]} s={[0.2, 0.2 + i * 0.1, 0.004]} c="#4cc9f0" emissive="#4cc9f0" emissiveIntensity={0.7} shadow={false} />
      ))}
    </group>
  );
}

const BOOK_COLORS = ['#ef476f', '#ffd166', '#06d6a0', '#118ab2', '#073b4c', '#9b5de5', '#f15bb5', '#e76f51', '#2a9d8f'];

function Bookshelf({ c }: { c: string }) {
  const shelves = [0.04, 0.52, 1.0, 1.48];
  return (
    <group>
      {[-0.97, 0.97].map((x) => (
        <Box key={x} p={[x, 1, 0]} s={[0.06, 2, 0.45]} c={c} />
      ))}
      <Box p={[0, 1, -0.21]} s={[2, 2, 0.03]} c={shade(c, -0.2)} />
      {[...shelves, 1.97].map((y) => (
        <Box key={y} p={[0, y, 0]} s={[1.9, 0.05, 0.42]} c={c} />
      ))}
      {shelves.map((y, row) => {
        let x = -0.85;
        const books = [];
        for (let i = 0; x < 0.8; i++) {
          const w = 0.07 + ((row * 7 + i * 13) % 5) * 0.015;
          const h = 0.28 + ((row * 3 + i * 7) % 4) * 0.035;
          if ((row + i) % 6 !== 5) {
            books.push(
              <Box key={i} p={[x + w / 2, y + 0.025 + h / 2, 0.02]} s={[w, h, 0.3]} c={BOOK_COLORS[(row * 5 + i * 3) % BOOK_COLORS.length]} shadow={false} />,
            );
          }
          x += w + 0.01;
        }
        return <group key={y}>{books}</group>;
      })}
    </group>
  );
}

function Printer() {
  return (
    <group>
      <Box p={[0, 0.2, 0]} s={[0.75, 0.4, 0.6]} c="#8d939c" />
      <Box p={[0, 0.62, 0]} s={[0.75, 0.42, 0.6]} c="#e6e8ec" rounded />
      <Box p={[0, 0.86, 0.05]} s={[0.5, 0.02, 0.4]} c="#ffffff" />
      <Box p={[0.2, 0.75, 0.3]} s={[0.2, 0.08, 0.01]} c="#4cc9f0" emissive="#4cc9f0" emissiveIntensity={0.6} shadow={false} />
    </group>
  );
}

function Counter({ c, sink }: { c: string; sink?: boolean }) {
  return (
    <group>
      <Box p={[0, 0.4, -0.1]} s={[2, 0.8, 0.75]} c={c} />
      <Box p={[0, 0.82, -0.08]} s={[2.02, 0.05, 0.82]} c="#3d3f45" roughness={0.4} />
      {[-0.5, 0.5].map((x) => (
        <Box key={x} p={[x, 0.42, 0.28]} s={[0.94, 0.7, 0.01]} c={shade(c, -0.06)} />
      ))}
      {[-0.08, 0.08].map((x) => (
        <Box key={x} p={[x, 0.6, 0.29]} s={[0.03, 0.15, 0.02]} c={METAL} />
      ))}
      {sink !== false && (
        <>
          <Box p={[0.45, 0.845, -0.1]} s={[0.55, 0.01, 0.4]} c="#9aa3ad" metalness={0.6} roughness={0.3} />
          <Cyl p={[0.45, 0.95, -0.36]} rad={0.025} h={0.2} c="#c9ced6" metalness={0.8} roughness={0.2} />
          <Box p={[0.45, 1.05, -0.28]} s={[0.04, 0.03, 0.18]} c="#c9ced6" metalness={0.8} roughness={0.2} />
        </>
      )}
      <Ball p={[-0.5, 0.9, -0.1]} s={[0.12, 0.06, 0.12]} c="#ffca3a" />
    </group>
  );
}

function CoffeeMachine({ c }: { c: string }) {
  return (
    <group>
      <Box p={[0, 0.4, -0.1]} s={[1, 0.8, 0.75]} c={c} />
      <Box p={[0, 0.82, -0.08]} s={[1.02, 0.05, 0.82]} c="#3d3f45" roughness={0.4} />
      <Box p={[0, 1.08, -0.2]} s={[0.42, 0.48, 0.38]} c="#1d1f24" rounded />
      <Box p={[0, 0.95, 0]} s={[0.2, 0.04, 0.12]} c={METAL} />
      <Box p={[0.1, 1.2, -0.005]} s={[0.12, 0.06, 0.01]} c="#ff924c" emissive="#ff924c" emissiveIntensity={0.7} shadow={false} />
      {[-0.35, -0.25].map((x) => (
        <Cyl key={x} p={[x, 0.9, 0.05]} rad={0.04} h={0.1} c="#ffffff" />
      ))}
    </group>
  );
}

function Fridge({ c }: { c: string }) {
  return (
    <group>
      <Box p={[0, 0.92, -0.05]} s={[0.85, 1.84, 0.75]} c={c} rounded roughness={0.35} />
      <Box p={[0, 1.25, 0.325]} s={[0.84, 0.015, 0.01]} c="#8d939c" />
      <Box p={[0.32, 1.5, 0.34]} s={[0.04, 0.3, 0.04]} c={METAL} metalness={0.6} />
      <Box p={[0.32, 0.95, 0.34]} s={[0.04, 0.3, 0.04]} c={METAL} metalness={0.6} />
      <Box p={[-0.15, 1.55, 0.325]} s={[0.12, 0.12, 0.005]} c="#ffd166" shadow={false} />
    </group>
  );
}

function Vending({ c }: { c: string }) {
  const cans = ['#ef476f', '#ffd166', '#06d6a0', '#118ab2', '#f15bb5'];
  return (
    <group>
      <Box p={[0, 0.92, -0.05]} s={[0.9, 1.84, 0.75]} c={c} rounded />
      <Box p={[-0.1, 1.15, 0.325]} s={[0.56, 1.2, 0.01]} c="#d9f0ff" emissive="#bfe3ff" emissiveIntensity={0.35} shadow={false} />
      {[0, 1, 2, 3].flatMap((row) =>
        [0, 1, 2].map((col) => (
          <Box key={`${row}${col}`} p={[-0.28 + col * 0.18, 0.7 + row * 0.27, 0.33]} s={[0.1, 0.16, 0.01]} c={cans[(row + col) % cans.length]} shadow={false} />
        )),
      )}
      <Box p={[0.32, 1.2, 0.33]} s={[0.16, 0.5, 0.01]} c="#2d2f36" />
      <Box p={[0, 0.25, 0.33]} s={[0.6, 0.15, 0.01]} c="#1d1f24" />
    </group>
  );
}

function WaterCooler() {
  return (
    <group>
      <Box p={[0, 0.45, 0]} s={[0.36, 0.9, 0.36]} c="#eef1f5" rounded />
      <Box p={[0, 0.72, 0.185]} s={[0.12, 0.05, 0.02]} c="#118ab2" />
      <Cyl p={[0, 1.1, 0]} rad={0.15} h={0.42} c="#8ecdf7" o={0.65} roughness={0.1} shadow={false} />
    </group>
  );
}

function Wall({ c, length }: { c: string; length: number }) {
  return (
    <group>
      <Box p={[0, 1.3, 0]} s={[length, 2.6, 0.2]} c={c} />
      <Box p={[0, 0.06, 0]} s={[length, 0.12, 0.22]} c={shade(c, -0.25)} />
    </group>
  );
}

function GlassWall() {
  return (
    <group>
      {[-0.97, 0.97].map((x) => (
        <Box key={x} p={[x, 1.3, 0]} s={[0.06, 2.6, 0.12]} c="#9aa5b1" metalness={0.4} roughness={0.4} />
      ))}
      <Box p={[0, 0.03, 0]} s={[2, 0.06, 0.12]} c="#9aa5b1" />
      <Box p={[0, 2.57, 0]} s={[2, 0.06, 0.12]} c="#9aa5b1" />
      <Box p={[0, 1.3, 0]} s={[1.88, 2.48, 0.03]} c="#bfe3ff" o={0.22} roughness={0.05} shadow={false} />
      <Box p={[0, 1.1, 0.02]} s={[1.88, 0.08, 0.005]} c="#ffffff" o={0.5} shadow={false} />
    </group>
  );
}

function Partition({ c }: { c: string }) {
  return (
    <group>
      <Box p={[0, 0.6, 0]} s={[2, 1.16, 0.1]} c={c} />
      <Box p={[0, 1.19, 0]} s={[2.02, 0.04, 0.14]} c="#c9ced6" />
      {[-0.9, 0.9].map((x) => (
        <Box key={x} p={[x, 0.02, 0]} s={[0.08, 0.04, 0.35]} c={METAL} />
      ))}
    </group>
  );
}

function Plant() {
  return (
    <group>
      <Cyl p={[0, 0.2, 0]} rad={0.2} top={1.35} h={0.4} c="#d9774a" />
      <Cyl p={[0, 0.4, 0]} rad={0.25} h={0.02} c="#4a3326" shadow={false} />
      <Ball p={[0, 0.68, 0]} s={[0.32, 0.36, 0.32]} c="#3a9d5d" />
      <Ball p={[0.15, 0.85, 0.05]} s={[0.2, 0.24, 0.2]} c="#46b36b" />
      <Ball p={[-0.13, 0.9, -0.08]} s={[0.18, 0.22, 0.18]} c="#2f8f55" />
    </group>
  );
}

function TallPlant() {
  return (
    <group>
      <Cyl p={[0, 0.22, 0]} rad={0.2} top={1.25} h={0.44} c="#f2f2f2" />
      <Cyl p={[0, 0.9, 0]} rad={0.035} h={1} c="#6b4423" />
      <Ball p={[0, 1.55, 0]} s={[0.42, 0.4, 0.42]} c="#2f8f55" />
      <Ball p={[0.2, 1.8, 0.1]} s={[0.28, 0.28, 0.28]} c="#3aa864" />
      <Ball p={[-0.18, 1.85, -0.12]} s={[0.25, 0.25, 0.25]} c="#2a7d4b" />
      <Ball p={[0.05, 1.25, -0.2]} s={[0.22, 0.2, 0.22]} c="#3a9d5d" />
    </group>
  );
}

function FloorLamp({ c }: { c: string }) {
  return (
    <group>
      <Cyl p={[0, 0.02, 0]} rad={0.17} h={0.04} c={DARK} />
      <Cyl p={[0, 0.78, 0]} rad={0.02} h={1.5} c={METAL} />
      <Cyl p={[0, 1.6, 0]} rad={0.24} top={0.6} h={0.32} c={c} emissive={c} emissiveIntensity={0.8} />
    </group>
  );
}

function Art({ c }: { c: string }) {
  return (
    <group>
      <Box p={[0, 1.6, 0]} s={[1.4, 0.95, 0.05]} c="#2d2f36" />
      <Box p={[0, 1.6, 0.03]} s={[1.28, 0.83, 0.01]} c="#f6f1e7" shadow={false} />
      <Ball p={[-0.25, 1.65, 0.04]} s={[0.22, 0.22, 0.01]} c={c} shadow={false} />
      <Box p={[0.2, 1.5, 0.04]} s={[0.45, 0.35, 0.01]} c={shade(c, -0.35)} shadow={false} />
      <Box p={[0.05, 1.8, 0.042]} s={[0.7, 0.05, 0.01]} c="#ffd166" shadow={false} />
    </group>
  );
}

function Rug({ c, w, d }: { c: string; w: number; d: number }) {
  return (
    <group>
      <Box p={[0, 0.006, 0]} s={[w, 0.012, d]} c={c} shadow={false} />
      <Box p={[0, 0.0125, 0]} s={[w - 0.3, 0.002, d - 0.3]} c={shade(c, 0.18)} shadow={false} />
      <Box p={[0, 0.014, 0]} s={[w - 0.5, 0.002, d - 0.5]} c={c} shadow={false} />
    </group>
  );
}

function RoundRug({ c }: { c: string }) {
  return (
    <group>
      <Cyl p={[0, 0.006, 0]} rad={1} h={0.012} c={c} seg={40} shadow={false} />
      <Cyl p={[0, 0.0125, 0]} rad={0.8} h={0.002} c={shade(c, 0.2)} seg={40} shadow={false} />
      <Cyl p={[0, 0.014, 0]} rad={0.65} h={0.002} c={c} seg={40} shadow={false} />
    </group>
  );
}

function PingPong() {
  return (
    <group>
      <Box p={[0, 0.68, 0]} s={[2.74, 0.05, 1.52]} c="#1f6f50" roughness={0.5} />
      <Box p={[0, 0.706, 0]} s={[2.74, 0.004, 0.03]} c="#ffffff" shadow={false} />
      <Box p={[0, 0.706, 0.74]} s={[2.74, 0.004, 0.03]} c="#ffffff" shadow={false} />
      <Box p={[0, 0.706, -0.74]} s={[2.74, 0.004, 0.03]} c="#ffffff" shadow={false} />
      <Box p={[0, 0.78, 0]} s={[0.02, 0.15, 1.65]} c="#f2f2f2" o={0.75} />
      {[-1.15, 1.15].flatMap((x) => [-0.6, 0.6].map((z) => <Box key={`${x}${z}`} p={[x, 0.33, z]} s={[0.06, 0.66, 0.06]} c={DARK} />))}
      <Cyl p={[0.9, 0.715, 0.35]} rad={0.08} h={0.015} c="#d62828" />
      <Cyl p={[-0.95, 0.715, -0.3]} rad={0.08} h={0.015} c="#1d3557" />
      <Ball p={[0.3, 0.73, 0.1]} rad={0.02} c="#ff924c" />
    </group>
  );
}

function Arcade({ c }: { c: string }) {
  return (
    <group>
      <Box p={[0, 0.85, -0.08]} s={[0.8, 1.7, 0.65]} c={c} rounded />
      <Box p={[0, 1.3, 0.25]} s={[0.62, 0.48, 0.02]} r={[-0.18, 0, 0]} c="#111216" />
      <Box p={[0, 1.3, 0.262]} s={[0.56, 0.42, 0.005]} r={[-0.18, 0, 0]} c="#6cf" emissive="#36c5f0" emissiveIntensity={0.8} shadow={false} />
      <Box p={[0, 0.95, 0.3]} s={[0.78, 0.07, 0.3]} r={[0.25, 0, 0]} c="#1d1f24" />
      <Cyl p={[-0.15, 1.02, 0.32]} rad={0.015} h={0.08} c={METAL} />
      <Ball p={[-0.15, 1.07, 0.32]} rad={0.035} c="#d62828" />
      {[0.08, 0.18, 0.28].map((x, i) => (
        <Cyl key={x} p={[x, 1.0, 0.33]} rad={0.025} h={0.02} c={['#ffd166', '#06d6a0', '#ef476f'][i]} />
      ))}
      <Box p={[0, 1.65, 0.22]} s={[0.8, 0.16, 0.1]} c="#ffca3a" emissive="#ffca3a" emissiveIntensity={0.6} />
    </group>
  );
}

/** Renders any catalogue item by type. */
export const ItemModel = memo(function ItemModel({ type, color }: { type: string; color?: string }) {
  const entry = getEntry(type);
  const c = color ?? entry?.defaultColor ?? '#cccccc';
  switch (type) {
    case 'desk': return <Desk c={c} />;
    case 'chair': return <Chair c={c} />;
    case 'stool': return <Stool c={c} />;
    case 'armchair': return <Armchair c={c} />;
    case 'sofa': return <Armchair c={c} width={2} />;
    case 'beanbag': return <Beanbag c={c} />;
    case 'coffee-table': return <CoffeeTable c={c} />;
    case 'round-table': return <RoundTable c={c} />;
    case 'meeting-table': return <MeetingTable c={c} />;
    case 'reception': return <Reception c={c} />;
    case 'whiteboard': return <Whiteboard />;
    case 'tv': return <Tv />;
    case 'bookshelf': return <Bookshelf c={c} />;
    case 'printer': return <Printer />;
    case 'counter': return <Counter c={c} />;
    case 'coffee-machine': return <CoffeeMachine c={c} />;
    case 'fridge': return <Fridge c={c} />;
    case 'vending': return <Vending c={c} />;
    case 'water-cooler': return <WaterCooler />;
    case 'wall': return <Wall c={c} length={2} />;
    case 'wall-short': return <Wall c={c} length={1} />;
    case 'glass-wall': return <GlassWall />;
    case 'partition': return <Partition c={c} />;
    case 'plant': return <Plant />;
    case 'tall-plant': return <TallPlant />;
    case 'floor-lamp': return <FloorLamp c={c} />;
    case 'art': return <Art c={c} />;
    case 'rug': return <Rug c={c} w={3} d={2} />;
    case 'rug-round': return <RoundRug c={c} />;
    case 'ping-pong': return <PingPong />;
    case 'arcade': return <Arcade c={c} />;
    default: return <Box p={[0, 0.25, 0]} s={[0.5, 0.5, 0.5]} c="#ff00ff" />;
  }
});
