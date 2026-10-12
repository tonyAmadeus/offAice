import React from 'react';
import {useCurrentFrame} from 'remotion';
import {INK} from '../theme';

const OUT = {stroke: INK, strokeWidth: 4, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const};

/** 房间底板：墙、窗、地板。dark 为 0~1 的熄灯程度。 */
export const Room: React.FC<{wall?: string; wallDark?: string; floor?: string; windows?: number[]; dark?: number}> = ({
	wall = '#fff3e6',
	wallDark = '#ffe2cc',
	floor = '#e9b98a',
	windows = [260, 1340],
	dark = 0,
}) => {
	const frame = useCurrentFrame();
	return (
		<g>
			<rect width={1920} height={1080} fill={wall} />
			{Array.from({length: 24}).map((_, i) => (
				<rect key={i} x={i * 80} y={0} width={40} height={760} fill={wallDark} opacity={0.35} />
			))}
			{windows.map((wx) => (
				<Window key={wx} x={wx} y={120} frame={frame} />
			))}
			<rect y={700} width={1920} height={60} fill="#fff" {...OUT} strokeWidth={0} />
			<rect y={700} width={1920} height={14} fill="#f7d7bd" />
			<rect y={760} width={1920} height={320} fill={floor} />
			{Array.from({length: 9}).map((_, i) => (
				<path key={i} d={`M 0 ${780 + i * 36} H 1920`} stroke="#d8a170" strokeWidth={3} />
			))}
			{Array.from({length: 40}).map((_, i) => (
				<path key={`v${i}`} d={`M ${((i * 173) % 1920) + (i % 2) * 60} ${780 + (i % 9) * 36} v 36`} stroke="#d8a170" strokeWidth={3} />
			))}
			<rect y={756} width={1920} height={8} fill="#c98b5a" />
			{dark > 0 ? <rect width={1920} height={1080} fill="#16122a" opacity={dark * 0.86} /> : null}
		</g>
	);
};

const Window: React.FC<{x: number; y: number; frame: number}> = ({x, y, frame}) => {
	const cloud = (cx: number, cy: number, s: number, speed: number) => {
		const px = ((cx + frame * speed) % 420) - 30;
		return (
			<g transform={`translate(${x + px} ${y + cy}) scale(${s})`}>
				<path d="M 0 20 q -20 0 -16 -18 q 6 -16 24 -10 q 8 -18 30 -10 q 18 -6 22 14 q 16 4 8 24 Z" fill="#fff" />
			</g>
		);
	};
	return (
		<g>
			<defs>
				<clipPath id={`win${x}`}>
					<rect x={x} y={y} width={360} height={420} rx={16} />
				</clipPath>
				<linearGradient id={`sky${x}`} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="#8fd3ff" />
					<stop offset="1" stopColor="#d9f1ff" />
				</linearGradient>
			</defs>
			<rect x={x - 16} y={y - 16} width={392} height={452} rx={24} fill="#fff" {...OUT} />
			<g clipPath={`url(#win${x})`}>
				<rect x={x} y={y} width={360} height={420} fill={`url(#sky${x})`} />
				{cloud(40, 60, 1.2, 0.6)}
				{cloud(220, 130, 0.9, 0.9)}
				{cloud(120, 210, 0.7, 0.4)}
				<path
					d={`M ${x} ${y + 420} V ${y + 330} h 40 v -50 h 50 v 70 h 30 v -110 h 60 v 90 h 40 v -40 h 50 v 60 h 40 v -80 h 50 V ${y + 420} Z`}
					fill="#b8c8f0"
				/>
				<path d={`M ${x} ${y + 420} V ${y + 370} h 70 v -30 h 60 v 50 h 80 v -20 h 70 v 40 h 80 V ${y + 420} Z`} fill="#9fb2e6" />
			</g>
			<path d={`M ${x + 180} ${y} V ${y + 420} M ${x} ${y + 210} H ${x + 360}`} stroke="#fff" strokeWidth={14} />
			<rect x={x} y={y} width={360} height={420} rx={16} fill="none" {...OUT} />
			<rect x={x - 30} y={y + 424} width={420} height={22} rx={8} fill="#fff" {...OUT} />
		</g>
	);
};

export const Monitor: React.FC<{x: number; y: number; color: string; seed?: number; on?: boolean; s?: number}> = ({x, y, color, seed = 0, on = true, s = 1}) => {
	const frame = useCurrentFrame();
	const lines = 6;
	const scroll = Math.floor((frame + seed * 7) / 4);
	return (
		<g transform={`translate(${x} ${y}) scale(${s})`}>
			<rect x={-14} y={0} width={28} height={40} fill="#cfd3e6" {...OUT} strokeWidth={3} />
			<rect x={-40} y={34} width={80} height={12} rx={6} fill="#cfd3e6" {...OUT} strokeWidth={3} />
			<rect x={-110} y={-130} width={220} height={140} rx={14} fill="#2b2d45" {...OUT} />
			<rect x={-98} y={-118} width={196} height={116} rx={8} fill={on ? '#1d1f33' : '#11121e'} />
			{on
				? Array.from({length: lines}).map((_, i) => {
						const n = (scroll + i) * 37 + seed * 11;
						const w = 30 + (n % 110);
						const indent = ((n >> 2) % 3) * 16;
						return (
							<rect
								key={i}
								x={-88 + indent}
								y={-108 + i * 17}
								width={w}
								height={8}
								rx={4}
								fill={i % 3 === 0 ? color : i % 3 === 1 ? '#8be3c4' : '#ffd479'}
								opacity={0.9}
							/>
						);
					})
				: null}
		</g>
	);
};

export const Desk: React.FC<{x: number; y: number; w?: number; color?: string}> = ({x, y, w = 300, color = '#f6c48e'}) => (
	<g transform={`translate(${x} ${y})`}>
		<rect x={-w / 2 + 16} y={20} width={16} height={130} fill="#c98b5a" {...OUT} strokeWidth={3} />
		<rect x={w / 2 - 32} y={20} width={16} height={130} fill="#c98b5a" {...OUT} strokeWidth={3} />
		<rect x={-w / 2} y={0} width={w} height={28} rx={8} fill={color} {...OUT} />
		<rect x={-w / 2 + 24} y={28} width={w - 48} height={70} rx={6} fill="#e8a970" {...OUT} strokeWidth={3} />
		<rect x={-26} y={50} width={52} height={10} rx={5} fill="#c98b5a" />
	</g>
);

export const Keyboard: React.FC<{x: number; y: number}> = ({x, y}) => (
	<g transform={`translate(${x} ${y})`}>
		<rect x={-60} y={-10} width={120} height={16} rx={5} fill="#f2f2f8" {...OUT} strokeWidth={3} />
		<path d="M -50 -2 h 100" stroke="#c6c8dc" strokeWidth={4} strokeDasharray="6 4" />
	</g>
);

export const Plant: React.FC<{x: number; y: number; s?: number}> = ({x, y, s = 1}) => {
	const frame = useCurrentFrame();
	const r = Math.sin(frame / 20 + x) * 3;
	return (
		<g transform={`translate(${x} ${y}) scale(${s})`}>
			<g transform={`rotate(${r} 0 -60)`}>
				<path d="M 0 -60 C -60 -90 -70 -160 -40 -190 C -20 -150 -10 -110 0 -60 Z" fill="#7fcf8a" {...OUT} strokeWidth={3} />
				<path d="M 0 -60 C 60 -100 70 -170 30 -210 C 14 -160 6 -110 0 -60 Z" fill="#6cc07a" {...OUT} strokeWidth={3} />
				<path d="M 0 -60 C -20 -120 0 -180 10 -230 C 26 -170 20 -110 0 -60 Z" fill="#8edc98" {...OUT} strokeWidth={3} />
			</g>
			<path d="M -46 -70 L 46 -70 L 36 0 L -36 0 Z" fill="#ff9f7a" {...OUT} />
			<rect x={-52} y={-80} width={104} height={18} rx={6} fill="#ff8a64" {...OUT} strokeWidth={3} />
		</g>
	);
};

export const Lamp: React.FC<{x: number; on?: number}> = ({x, on = 1}) => (
	<g>
		<path d={`M ${x} 0 V 70`} stroke={INK} strokeWidth={4} />
		{on > 0 ? <path d={`M ${x - 60} 110 L ${x - 260} 760 L ${x + 260} 760 L ${x + 60} 110 Z`} fill="#fff7c2" opacity={0.18 * on} /> : null}
		<path d={`M ${x - 60} 112 Q ${x} 40 ${x + 60} 112 Z`} fill="#ffcf5a" {...OUT} />
		<ellipse cx={x} cy={114} rx={22} ry={10} fill={on > 0 ? '#fffbe0' : '#9a9aa8'} {...OUT} strokeWidth={3} />
	</g>
);

/** AIROOM 霓虹招牌。glow 0~1。 */
export const Sign: React.FC<{x: number; y: number; glow: number; s?: number}> = ({x, y, glow, s = 1}) => (
	<g transform={`translate(${x} ${y}) scale(${s})`}>
		<rect x={-250} y={-70} width={500} height={140} rx={30} fill="#3b2b52" {...OUT} />
		<text
			x={0}
			y={30}
			textAnchor="middle"
			fontFamily="Fredoka"
			fontWeight={700}
			fontSize={92}
			fill={glow > 0.5 ? '#fff' : '#6b5a80'}
			stroke={glow > 0.5 ? '#ff6fa3' : 'none'}
			strokeWidth={4}
			style={{filter: glow > 0.5 ? `drop-shadow(0 0 ${16 * glow}px #ff6fa3) drop-shadow(0 0 ${30 * glow}px #ff9fd0)` : undefined}}
		>
			AIROOM
		</text>
		<path d="M -200 -70 L -220 -120 M 200 -70 L 220 -120" stroke={INK} strokeWidth={4} />
	</g>
);

export const Clock: React.FC<{x: number; y: number; minutes: number; r?: number}> = ({x, y, minutes, r = 54}) => {
	const h = ((minutes / 60) % 12) * 30;
	const m = (minutes % 60) * 6;
	return (
		<g transform={`translate(${x} ${y})`}>
			<circle r={r} fill="#fff" {...OUT} strokeWidth={6} />
			{Array.from({length: 12}).map((_, i) => (
				<path key={i} d={`M 0 ${-r + 8} v 8`} stroke={INK} strokeWidth={3} transform={`rotate(${i * 30})`} />
			))}
			<path d={`M 0 0 L 0 ${-r * 0.5}`} stroke={INK} strokeWidth={6} strokeLinecap="round" transform={`rotate(${h})`} />
			<path d={`M 0 0 L 0 ${-r * 0.78}`} stroke="#ff6fa3" strokeWidth={4} strokeLinecap="round" transform={`rotate(${m})`} />
			<circle r={5} fill={INK} />
		</g>
	);
};

export const Bookshelf: React.FC<{x: number; y: number}> = ({x, y}) => {
	const colors = ['#ff9f7a', '#7fb2ff', '#ffd479', '#9b8cf0', '#7fcf8a', '#ff7aa8'];
	return (
		<g transform={`translate(${x} ${y})`}>
			<rect x={0} y={0} width={240} height={320} rx={8} fill="#d89a68" {...OUT} />
			{[0, 1, 2].map((row) => (
				<g key={row}>
					<rect x={12} y={12 + row * 102} width={216} height={88} fill="#b97a4c" />
					{Array.from({length: 7}).map((_, i) => (
						<rect
							key={i}
							x={18 + i * 30}
							y={30 + row * 102 - ((i + row) % 3) * 6}
							width={24}
							height={70 + ((i + row) % 3) * 6}
							rx={3}
							fill={colors[(i + row * 2) % colors.length]}
							{...OUT}
							strokeWidth={2.5}
						/>
					))}
				</g>
			))}
		</g>
	);
};

export const Whiteboard: React.FC<{x: number; y: number; w?: number; h?: number; children?: React.ReactNode}> = ({x, y, w = 760, h = 440, children}) => (
	<g transform={`translate(${x} ${y})`}>
		<rect x={-10} y={-10} width={w + 20} height={h + 20} rx={16} fill="#cfd3e6" {...OUT} />
		<rect x={0} y={0} width={w} height={h} rx={10} fill="#fff" />
		<rect x={w * 0.1} y={h + 10} width={w * 0.8} height={16} rx={6} fill="#cfd3e6" {...OUT} strokeWidth={3} />
		{children}
	</g>
);

export const Sofa: React.FC<{x: number; y: number; color?: string; w?: number}> = ({x, y, color = '#ff9fbf', w = 620}) => (
	<g transform={`translate(${x} ${y})`}>
		<rect x={-w / 2} y={-170} width={w} height={130} rx={40} fill={color} {...OUT} />
		<rect x={-w / 2 - 30} y={-100} width={80} height={130} rx={30} fill={color} {...OUT} />
		<rect x={w / 2 - 50} y={-100} width={80} height={130} rx={30} fill={color} {...OUT} />
		<rect x={-w / 2 + 40} y={-60} width={w - 80} height={70} rx={20} fill="#ffc4d8" {...OUT} />
		<path d={`M 0 -50 v 50`} stroke={INK} strokeWidth={3} />
	</g>
);

export const CoffeeMachine: React.FC<{x: number; y: number}> = ({x, y}) => {
	const frame = useCurrentFrame();
	return (
		<g transform={`translate(${x} ${y})`}>
			<rect x={-90} y={-60} width={180} height={60} rx={8} fill="#c98b5a" {...OUT} />
			<rect x={-60} y={-230} width={120} height={170} rx={16} fill="#5b4a6a" {...OUT} />
			<rect x={-40} y={-210} width={80} height={44} rx={8} fill="#9fe0ff" {...OUT} strokeWidth={3} />
			<rect x={-26} y={-150} width={52} height={40} rx={6} fill="#3b2b52" />
			<rect x={-14} y={-100} width={28} height={34} rx={5} fill="#fff" {...OUT} strokeWidth={3} />
			<path
				d={`M -4 -108 q -6 -10 0 -20 q 6 -10 0 -20 M 6 -108 q -6 -10 0 -20`}
				fill="none"
				stroke="#fff"
				strokeWidth={4}
				strokeLinecap="round"
				opacity={0.4 + 0.4 * Math.sin(frame / 4)}
			/>
		</g>
	);
};

export const Door: React.FC<{x: number; y: number; open?: number}> = ({x, y, open = 0}) => (
	<g transform={`translate(${x} ${y})`}>
		<rect x={-110} y={-420} width={220} height={420} fill="#5b4a6a" {...OUT} />
		<g transform={`translate(-100 0) scale(${1 - open * 0.75} 1)`}>
			<rect x={0} y={-410} width={200} height={410} rx={6} fill="#f6c48e" {...OUT} />
			<rect x={26} y={-380} width={148} height={150} rx={10} fill="#e8a970" {...OUT} strokeWidth={3} />
			<rect x={26} y={-200} width={148} height={170} rx={10} fill="#e8a970" {...OUT} strokeWidth={3} />
			<circle cx={172} cy={-200} r={10} fill="#ffd479" {...OUT} strokeWidth={3} />
		</g>
	</g>
);

export const RoundTable: React.FC<{x: number; y: number}> = ({x, y}) => (
	<g transform={`translate(${x} ${y})`}>
		<rect x={-30} y={20} width={60} height={160} fill="#c98b5a" {...OUT} />
		<ellipse cx={0} cy={180} rx={140} ry={26} fill="#c98b5a" {...OUT} />
		<ellipse cx={0} cy={10} rx={520} ry={70} fill="#c98b5a" {...OUT} />
		<ellipse cx={0} cy={0} rx={520} ry={70} fill="#f6c48e" {...OUT} />
		<ellipse cx={0} cy={0} rx={440} ry={50} fill="none" stroke="#e8a970" strokeWidth={4} />
	</g>
);

export const Chair: React.FC<{x: number; y: number; color?: string; spin?: number}> = ({x, y, color = '#7fb2ff', spin = 0}) => (
	<g transform={`translate(${x} ${y})`}>
		<path d="M 0 -40 V 0 M -40 10 L 40 10 M 0 0 L -30 18 M 0 0 L 30 18" stroke={INK} strokeWidth={6} strokeLinecap="round" />
		<circle cx={-40} cy={14} r={8} fill="#444" />
		<circle cx={40} cy={14} r={8} fill="#444" />
		<g transform={`scale(${Math.cos(spin)} 1)`}>
			<rect x={-60} y={-70} width={120} height={34} rx={14} fill={color} {...OUT} />
			<rect x={-50} y={-190} width={100} height={130} rx={30} fill={color} {...OUT} />
		</g>
	</g>
);
