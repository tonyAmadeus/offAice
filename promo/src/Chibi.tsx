import React, {useId} from 'react';
import {useCurrentFrame} from 'remotion';
import {MEMBERS, type MemberKey} from './members';
import {BLUSH, INK, SKIN, SKIN_SHADE} from './theme';

export type Eyes = 'open' | 'happy' | 'closed' | 'wink' | 'star' | 'dizzy' | 'angry' | 'shock' | 'flat';
export type Mouth = 'smile' | 'open' | 'o' | 'cat' | 'fang' | 'flat' | 'wave' | 'grin';
export type Prop = 'book' | 'fan' | 'axe' | 'mug' | 'paper' | 'pillow' | 'donut' | 'scroll' | 'plane' | 'none';

export interface ChibiProps {
	m: MemberKey;
	x: number;
	y: number;
	scale?: number;
	flip?: boolean;
	/** 手臂角度（度）：0 下垂，90 平举，180 举过头顶。 */
	armL?: number;
	armR?: number;
	/** 走路相位（弧度），不传则站立。 */
	walk?: number;
	tilt?: number;
	squash?: number;
	eyes?: Eyes;
	mouth?: Mouth;
	blush?: boolean;
	sweat?: boolean;
	lookX?: number;
	prop?: Prop;
	propHand?: 'L' | 'R';
	propRot?: number;
	flap?: boolean;
	shadow?: boolean;
	opacity?: number;
	seed?: number;
}

const OUT = {stroke: INK, strokeWidth: 3, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const};

const armVector = (side: -1 | 1, deg: number, len: number) => {
	const a = (deg * Math.PI) / 180;
	return {x: side * Math.sin(a) * len, y: Math.cos(a) * len};
};

const Eye: React.FC<{cx: number; cy: number; kind: Eyes; iris: string; side: -1 | 1; lookX: number; seed: number}> = ({
	cx,
	cy,
	kind,
	iris,
	side,
	lookX,
	seed,
}) => {
	if (kind === 'happy' || (kind === 'wink' && side === 1)) {
		return <path d={`M ${cx - 11} ${cy + 4} Q ${cx} ${cy - 10} ${cx + 11} ${cy + 4}`} fill="none" stroke={INK} strokeWidth={4} strokeLinecap="round" />;
	}
	if (kind === 'closed') {
		return <path d={`M ${cx - 11} ${cy} Q ${cx} ${cy + 7} ${cx + 11} ${cy}`} fill="none" stroke={INK} strokeWidth={3.5} strokeLinecap="round" />;
	}
	if (kind === 'flat') {
		return <path d={`M ${cx - 11} ${cy} L ${cx + 11} ${cy}`} stroke={INK} strokeWidth={4} strokeLinecap="round" />;
	}
	if (kind === 'dizzy') {
		return (
			<path
				d={`M ${cx} ${cy} m -2 0 a 2 2 0 1 1 4 0 a 5 5 0 1 1 -9 0 a 8 8 0 1 1 15 0 a 10 10 0 1 1 -19 1`}
				fill="none"
				stroke={INK}
				strokeWidth={2.5}
				transform={`rotate(${seed * 40} ${cx} ${cy})`}
			/>
		);
	}
	if (kind === 'shock') {
		return (
			<g>
				<ellipse cx={cx} cy={cy} rx={10} ry={12} fill="#fff" {...OUT} strokeWidth={2.5} />
				<circle cx={cx + lookX} cy={cy} r={2.8} fill={INK} />
			</g>
		);
	}
	if (kind === 'star') {
		const s = 13;
		return (
			<g transform={`translate(${cx} ${cy})`}>
				<path d={`M 0 ${-s} Q 2 -2 ${s} 0 Q 2 2 0 ${s} Q -2 2 ${-s} 0 Q -2 -2 0 ${-s} Z`} fill={iris} stroke={INK} strokeWidth={2} />
				<circle cx={-3} cy={-3} r={2.5} fill="#fff" />
			</g>
		);
	}
	const lx = cx + lookX;
	return (
		<g>
			<ellipse cx={lx} cy={cy + 1} rx={10.5} ry={13.5} fill={iris} stroke={INK} strokeWidth={2} />
			<ellipse cx={lx} cy={cy + 6} rx={7.5} ry={6.5} fill="#fff" opacity={0.3} />
			<ellipse cx={lx} cy={cy + 1} rx={5} ry={7.5} fill={INK} opacity={0.72} />
			<circle cx={lx + 3.5} cy={cy - 5} r={4.2} fill="#fff" />
			<circle cx={lx - 4} cy={cy + 6} r={2} fill="#fff" />
			<path d={`M ${cx - 12} ${cy - 7} C ${cx - 8} ${cy - 17} ${cx + 8} ${cy - 17} ${cx + 13} ${cy - 9}`} fill="none" stroke={INK} strokeWidth={4.5} strokeLinecap="round" />
			<path d={`M ${cx + side * 12} ${cy - 9} l ${side * 4} -2`} stroke={INK} strokeWidth={3} strokeLinecap="round" />
			{kind === 'angry' ? (
				<path d={`M ${cx - side * 12} ${cy - 30} L ${cx + side * 10} ${cy - 22}`} stroke={INK} strokeWidth={4} strokeLinecap="round" />
			) : null}
		</g>
	);
};

const MouthShape: React.FC<{kind: Mouth}> = ({kind}) => {
	const y = -106;
	switch (kind) {
		case 'open':
			return (
				<g>
					<path d={`M -10 ${y - 4} Q 0 ${y - 2} 10 ${y - 4} Q 8 ${y + 12} 0 ${y + 12} Q -8 ${y + 12} -10 ${y - 4} Z`} fill="#c2384f" {...OUT} strokeWidth={2.2} />
					<ellipse cx={0} cy={y + 8} rx={5} ry={3} fill="#ff8fa0" />
				</g>
			);
		case 'fang':
			return (
				<g>
					<path d={`M -10 ${y - 4} Q 0 ${y - 2} 10 ${y - 4} Q 8 ${y + 12} 0 ${y + 12} Q -8 ${y + 12} -10 ${y - 4} Z`} fill="#c2384f" {...OUT} strokeWidth={2.2} />
					<path d={`M 3 ${y - 3} L 6 ${y + 3} L 8 ${y - 3.5} Z`} fill="#fff" />
				</g>
			);
		case 'o':
			return <ellipse cx={0} cy={y + 2} rx={4.5} ry={5.5} fill="#c2384f" {...OUT} strokeWidth={2} />;
		case 'cat':
			return <path d={`M -9 ${y - 2} Q -4.5 ${y + 5} 0 ${y - 1} Q 4.5 ${y + 5} 9 ${y - 2}`} fill="none" stroke={INK} strokeWidth={2.6} strokeLinecap="round" />;
		case 'flat':
			return <path d={`M -6 ${y} L 6 ${y}`} stroke={INK} strokeWidth={2.6} strokeLinecap="round" />;
		case 'wave':
			return <path d={`M -9 ${y} q 3 -4 6 0 q 3 4 6 0 q 3 -4 6 0`} fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />;
		case 'grin':
			return <path d={`M -11 ${y - 4} Q 0 ${y - 1} 11 ${y - 4} Q 9 ${y + 8} 0 ${y + 8} Q -9 ${y + 8} -11 ${y - 4} Z`} fill="#fff" {...OUT} strokeWidth={2.2} />;
		default:
			return <path d={`M -7 ${y - 2} Q 0 ${y + 5} 7 ${y - 2}`} fill="none" stroke={INK} strokeWidth={2.6} strokeLinecap="round" />;
	}
};

const PropShape: React.FC<{prop: Prop; frame: number}> = ({prop, frame}) => {
	switch (prop) {
		case 'book':
			return (
				<g transform="translate(-14 -22)">
					<rect width={30} height={36} rx={3} fill="#6a2f22" {...OUT} />
					<rect x={4} y={4} width={22} height={28} rx={2} fill="none" stroke="#e7b860" strokeWidth={1.5} />
					<circle cx={15} cy={18} r={5} fill="#f07a3a" />
				</g>
			);
		case 'fan':
			return (
				<g transform="translate(0 2)">
					<path d="M 0 0 L -34 -30 A 45 45 0 0 1 34 -30 Z" fill="#9fb2ff" {...OUT} />
					<path d="M 0 0 L -22 -38 M 0 0 L -8 -44 M 0 0 L 8 -44 M 0 0 L 22 -38" stroke="#fff" strokeWidth={1.6} opacity={0.8} />
					<path d="M -14 -34 q 6 -6 12 0 q 6 6 12 0" fill="none" stroke="#fff" strokeWidth={2} />
				</g>
			);
		case 'axe':
			return (
				<g transform="scale(0.85)">
					<rect x={-4} y={-120} width={8} height={170} rx={4} fill="#3a2a2a" {...OUT} />
					<path
						d="M 0 -112 C -30 -150 -60 -150 -70 -130 C -56 -126 -48 -112 -52 -96 C -30 -106 -14 -104 0 -92 C 14 -104 30 -106 52 -96 C 48 -112 56 -126 70 -130 C 60 -150 30 -150 0 -112 Z"
						fill="#2e2428"
						{...OUT}
					/>
					<path d="M -30 -130 L 30 -100 M 30 -130 L -30 -100" stroke="#d8a84a" strokeWidth={6} strokeLinecap="round" />
					<path d="M 0 -120 L 0 -140" stroke={INK} strokeWidth={5} />
				</g>
			);
		case 'mug':
			return (
				<g transform="translate(-10 -16)">
					<rect width={20} height={22} rx={4} fill="#fff" {...OUT} />
					<path d="M 20 5 q 9 0 9 7 q 0 6 -9 6" fill="none" stroke={INK} strokeWidth={3} />
					<path
						d={`M 6 -4 q -4 -6 0 -12 q 4 -6 0 -12 M 14 -4 q -4 -6 0 -12`}
						fill="none"
						stroke="#c7b8ad"
						strokeWidth={2.5}
						strokeLinecap="round"
						opacity={0.5 + 0.4 * Math.sin(frame / 5)}
					/>
				</g>
			);
		case 'paper':
			return (
				<g transform="translate(-16 -30)">
					<rect width={32} height={40} rx={2} fill="#fff" {...OUT} />
					<path d="M 6 10 h 20 M 6 17 h 20 M 6 24 h 14" stroke="#9aa5c8" strokeWidth={2.5} strokeLinecap="round" />
				</g>
			);
		case 'pillow':
			return (
				<g transform="translate(0 -14)">
					<rect x={-30} y={-20} width={60} height={40} rx={16} fill="#ffc4d8" {...OUT} />
					<path d="M -14 0 h 28" stroke="#ff8fb5" strokeWidth={3} strokeLinecap="round" />
				</g>
			);
		case 'donut':
			return (
				<g transform="translate(0 -6)">
					<circle r={18} fill="#e8b06a" {...OUT} />
					<path d="M -16 -4 Q -14 -16 0 -17 Q 14 -16 16 -4 Q 10 2 0 -2 Q -10 2 -16 -4 Z" fill="#ff8fc0" />
					<circle r={6} fill="#fff8ef" {...OUT} strokeWidth={2} />
					<path d="M -8 -10 l 3 1 M 6 -12 l 2 3 M 10 -6 l 3 0" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
				</g>
			);
		case 'scroll':
			return (
				<g transform="translate(0 -6)">
					<rect x={-24} y={-8} width={48} height={16} rx={8} fill="#fff6dc" {...OUT} />
					<circle cx={-24} cy={0} r={8} fill="#e8d4a0" {...OUT} strokeWidth={2} />
				</g>
			);
		case 'plane':
			return (
				<g transform="translate(0 -10) rotate(-20)">
					<path d="M -22 0 L 26 -10 L -8 8 Z" fill="#fff" {...OUT} strokeWidth={2.4} />
					<path d="M -8 8 L 26 -10 L -4 14 Z" fill="#e3e8ff" {...OUT} strokeWidth={2.4} />
				</g>
			);
		default:
			return null;
	}
};

export const Chibi: React.FC<ChibiProps> = ({
	m,
	x,
	y,
	scale = 1,
	flip = false,
	armL = 12,
	armR = 12,
	walk,
	tilt = 0,
	squash = 0,
	eyes = 'open',
	mouth = 'smile',
	blush = true,
	sweat = false,
	lookX = 0,
	prop = 'none',
	propHand = 'R',
	propRot = 0,
	flap = false,
	shadow = true,
	opacity = 1,
	seed = 0,
}) => {
	const frame = useCurrentFrame();
	const L = MEMBERS[m].look;
	const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
	const hairFill = `url(#hair${uid})`;
	const off = seed * 17 + m.length * 13;
	const sway = Math.sin((frame + off) / 9) * 3;
	const blinking = eyes === 'open' && (frame + off * 3) % 97 < 4;
	const eyeKind: Eyes = blinking ? 'closed' : eyes;

	const legSwing = walk === undefined ? 0 : Math.sin(walk) * 26;
	const bodyBob = walk === undefined ? 0 : -Math.abs(Math.cos(walk)) * 6;

	const shoulderY = -92;
	const handL = armVector(-1, armL, 34);
	const handR = armVector(1, armR, 34);
	const longSkirt = !L.shortSkirt;
	const hemY = longSkirt ? -10 : -38;
	const hemW = longSkirt ? 50 : 42;
	const hipY = longSkirt ? -14 : -40;
	const legLen = -hipY - 4;

	const leg = (side: -1 | 1) => {
		const a = ((side === -1 ? legSwing : -legSwing) * Math.PI) / 180;
		const hx = side * 10;
		const fx = hx + Math.sin(a) * legLen;
		const fy = hipY + Math.cos(a) * legLen;
		return (
			<g key={side}>
				<path d={`M ${hx} ${hipY} L ${fx} ${fy}`} stroke={INK} strokeWidth={14} strokeLinecap="round" />
				<path d={`M ${hx} ${hipY} L ${fx} ${fy}`} stroke={L.legs} strokeWidth={9} strokeLinecap="round" />
				<ellipse cx={fx + side * 3} cy={fy + 1} rx={10} ry={6.5} fill={L.shoes} {...OUT} strokeWidth={2.5} />
			</g>
		);
	};

	const tail = () => {
		if (L.tail === 'none') return null;
		const rot = Math.sin((frame + off) / 7) * 10;
		const root = 'translate(18 -42)';
		if (L.tail === 'dragon') {
			return (
				<g transform={`${root} rotate(${rot})`}>
					<path d="M 0 0 C 40 10 70 -10 78 -48" fill="none" stroke={INK} strokeWidth={22} strokeLinecap="round" />
					<path d="M 0 0 C 40 10 70 -10 78 -48" fill="none" stroke={L.tailColor} strokeWidth={16} strokeLinecap="round" />
					<path d="M 28 -2 l 6 -12 l 4 11 M 52 -10 l 8 -10 l 1 12" fill={L.tailTip} {...OUT} strokeWidth={2} />
					<path d="M 74 -50 L 92 -66 L 86 -42 Z" fill={L.tailTip} {...OUT} strokeWidth={2} />
				</g>
			);
		}
		if (L.tail === 'whale') {
			return (
				<g transform={`${root} rotate(${rot})`}>
					<path d="M 0 0 C 30 6 50 -14 58 -40" fill="none" stroke={INK} strokeWidth={20} strokeLinecap="round" />
					<path d="M 0 0 C 30 6 50 -14 58 -40" fill="none" stroke={L.tailColor} strokeWidth={14} strokeLinecap="round" />
					<path d="M 58 -40 C 44 -60 34 -62 30 -58 C 44 -54 52 -46 58 -40 C 66 -50 82 -62 92 -58 C 82 -54 70 -46 58 -40 Z" fill={L.tailColor} {...OUT} />
				</g>
			);
		}
		if (L.tail === 'cat') {
			return (
				<g transform={`${root} rotate(${rot * 1.4})`}>
					<path d="M 0 0 C 40 0 30 -40 56 -50 C 72 -56 80 -40 72 -32" fill="none" stroke={INK} strokeWidth={16} strokeLinecap="round" />
					<path d="M 0 0 C 40 0 30 -40 56 -50 C 72 -56 80 -40 72 -32" fill="none" stroke={L.tailColor} strokeWidth={10} strokeLinecap="round" />
					<path d="M 56 -50 C 72 -56 80 -40 72 -32" fill="none" stroke={L.tailTip} strokeWidth={10} strokeLinecap="round" />
				</g>
			);
		}
		return (
			<g transform={`${root} rotate(${rot})`}>
				<path d="M 0 0 C 20 20 70 10 84 -40 C 92 -70 70 -96 56 -98 C 60 -70 40 -30 0 -14 Z" fill={L.tailColor} {...OUT} />
				<path d="M 84 -40 C 92 -70 70 -96 56 -98 C 60 -86 60 -70 54 -60 C 66 -60 78 -52 84 -40 Z" fill={L.tailTip} {...OUT} strokeWidth={2} />
			</g>
		);
	};

	const wings = () => {
		if (!L.wings) return null;
		const f = flap ? Math.sin(frame / 2.2) * 22 : Math.sin(frame / 12) * 5;
		const wing = (side: -1 | 1) => (
			<g key={side} transform={`translate(${side * 14} -90) scale(${side} 1) rotate(${-f})`}>
				<path
					d="M 0 0 C 30 -30 70 -50 104 -44 C 92 -30 96 -18 90 -6 C 78 -16 70 -6 66 6 C 56 -4 44 2 40 14 C 28 6 14 8 0 14 Z"
					fill="#f4f0ff"
					{...OUT}
				/>
				<path d="M 6 4 L 100 -42 M 30 -4 L 66 6 M 22 0 L 40 14" stroke="#cfc4f0" strokeWidth={2} />
			</g>
		);
		return [wing(-1), wing(1)];
	};

	const backHair = () => {
		const s = sway;
		if (L.style === 'twintail') {
			return <path d="M -60 -170 C -70 -140 -64 -118 -56 -104 L 56 -104 C 64 -118 70 -140 60 -170 Z" fill={hairFill} {...OUT} />;
		}
		if (L.style === 'braid') {
			return <path d={`M -62 -168 C -78 -130 -74 -96 ${-66 + s} -66 L ${66 + s} -66 C 74 -96 78 -130 62 -168 Z`} fill={hairFill} {...OUT} />;
		}
		if (L.style === 'wavy') {
			return (
				<path
					d={`M -62 -172 C -86 -130 -88 -86 ${-80 + s} -40 Q ${-66 + s} -48 ${-56 + s} -34 Q ${-44 + s} -46 ${-30 + s} -36 L ${30 + s} -36 Q ${44 + s} -46 ${56 + s} -34 Q ${66 + s} -48 ${80 + s} -40 C 88 -86 86 -130 62 -172 Z`}
					fill={hairFill}
					{...OUT}
				/>
			);
		}
		return <path d={`M -62 -170 C -76 -120 -74 -80 ${-68 + s} -30 L ${-54 + s} -40 L ${-44 + s} -26 L ${44 + s} -26 L ${54 + s} -40 L ${68 + s} -30 C 74 -80 76 -120 62 -170 Z`} fill={hairFill} {...OUT} />;
	};

	const twinTails = () => {
		if (L.style !== 'twintail') return null;
		const t = (side: -1 | 1) => (
			<g key={side} transform={`scale(${side} 1) rotate(${sway * 1.5} 52 -186)`}>
				<path
					d="M 46 -188 C 104 -184 112 -120 94 -74 C 86 -52 100 -40 86 -24 C 74 -46 70 -60 72 -84 C 74 -112 66 -150 40 -170 Z"
					fill={hairFill}
					{...OUT}
				/>
				<path d="M 90 -90 c -6 10 -4 20 4 26" fill="none" stroke={L.hairShade} strokeWidth={2.5} />
				<path d="M 48 -196 L 30 -214 L 34 -186 Z M 52 -196 L 74 -212 L 68 -184 Z" fill="#1d1820" {...OUT} strokeWidth={2} />
				<path d="M 70 -210 l 14 -6 l -6 10 l 10 0 l -12 8 Z" fill="#1d1820" {...OUT} strokeWidth={1.5} />
				<circle cx={50} cy={-194} r={6} fill="#1d1820" {...OUT} strokeWidth={2} />
			</g>
		);
		return [t(-1), t(1)];
	};

	const ears = () => {
		const e = L.ears;
		if (e === 'elf') {
			return [-1, 1].map((s) => (
				<path key={s} d={`M ${s * 50} -148 L ${s * 74} -164 L ${s * 52} -126 Z`} fill={SKIN} {...OUT} strokeWidth={2.5} />
			));
		}
		if (e === 'fin') {
			return [-1, 1].map((s) => (
				<g key={s}>
					<path d={`M ${s * 52} -156 C ${s * 82} -158 ${s * 96} -134 ${s * 92} -116 C ${s * 80} -128 ${s * 68} -134 ${s * 52} -132 Z`} fill="#3a3f78" {...OUT} />
					<path d={`M ${s * 58} -140 C ${s * 70} -140 ${s * 80} -134 ${s * 86} -124`} fill="none" stroke="#9fb4ff" strokeWidth={2.5} />
				</g>
			));
		}
		if (e === 'cat' || e === 'fox') {
			const big = e === 'fox';
			const twitch = Math.max(0, Math.sin((frame + off) / 23)) > 0.97 ? 8 : 0;
			return [-1, 1].map((s) => (
				<g key={s} transform={`rotate(${s * twitch} ${s * 34} -196)`}>
					<path
						d={big ? `M ${s * 58} -184 L ${s * 54} -246 L ${s * 12} -206 Z` : `M ${s * 54} -186 L ${s * 48} -234 L ${s * 16} -206 Z`}
						fill={L.hair}
						{...OUT}
					/>
					<path
						d={big ? `M ${s * 48} -194 L ${s * 50} -232 L ${s * 24} -206 Z` : `M ${s * 46} -194 L ${s * 44} -222 L ${s * 26} -206 Z`}
						fill={big ? '#e8e8f0' : '#ffb2cf'}
					/>
				</g>
			));
		}
		return null;
	};

	const accessories = () => (
		<g>
			{L.horns
				? [-1, 1].map((s) => (
						<g key={s} transform={`scale(${s} 1)`}>
							<path d="M 26 -204 C 30 -230 22 -250 8 -262 C 30 -258 46 -238 40 -200 Z" fill="#fbfaff" {...OUT} />
							<path d="M 30 -214 l 10 2 M 28 -228 l 10 0 M 22 -242 l 9 -3" stroke="#bcb0e6" strokeWidth={2.5} strokeLinecap="round" />
						</g>
					))
				: null}
			{L.maidBand ? (
				<g>
					<path d="M -54 -188 Q 0 -238 54 -188" fill="none" stroke={INK} strokeWidth={14} strokeLinecap="round" />
					<path d="M -54 -188 Q 0 -238 54 -188" fill="none" stroke="#fff" strokeWidth={9} strokeLinecap="round" />
					{[-40, -20, 0, 20, 40].map((px) => (
						<circle key={px} cx={px} cy={-200 - (1 - (px / 54) ** 2) * 12} r={7} fill="#fff" {...OUT} strokeWidth={2} />
					))}
				</g>
			) : null}
			{L.hat ? (
				<g transform="translate(22 -208) rotate(14)">
					<ellipse cx={0} cy={10} rx={34} ry={9} fill="#f3f4ff" {...OUT} />
					<rect x={-24} y={-16} width={48} height={26} rx={9} fill="#2e3170" {...OUT} />
					<circle cx={0} cy={-2} r={8} fill="#fff" {...OUT} strokeWidth={2} />
					<path d="M -3 -6 l 6 0 l -3 7 Z" fill="#5466d8" />
					<path d="M 22 4 l 10 22" stroke="#7f9cff" strokeWidth={4} strokeLinecap="round" />
				</g>
			) : null}
			{L.flower ? (
				<g transform="translate(44 -190)">
					{Array.from({length: 10}).map((_, i) => (
						<ellipse key={i} cx={0} cy={-11} rx={4.5} ry={10} fill="#f5803e" stroke={INK} strokeWidth={1.5} transform={`rotate(${i * 36})`} />
					))}
					<circle r={6} fill="#e7b860" {...OUT} strokeWidth={2} />
					<path d="M -8 10 l -10 24 l 8 -2 l 2 8" fill="#2d2430" {...OUT} strokeWidth={2} />
				</g>
			) : null}
			{L.star ? (
				<g transform={`translate(42 -200) rotate(${frame * 2})`}>
					<path d="M 0 -16 Q 3 -3 16 0 Q 3 3 0 16 Q -3 3 -16 0 Q -3 -3 0 -16 Z" fill="#c4b2ff" {...OUT} strokeWidth={2} />
					<path d="M 0 -8 Q 1 -1 8 0" fill="none" stroke="#fff" strokeWidth={2} />
				</g>
			) : null}
			{L.moon ? (
				<g transform="translate(-42 -204) rotate(-20)">
					<path d="M 0 -16 A 16 16 0 1 0 0 16 A 12 12 0 1 1 0 -16 Z" fill="#e4e8ff" {...OUT} strokeWidth={2} />
					<path d="M 18 -10 v 16 m 0 -16 l 8 2" fill="none" stroke={INK} strokeWidth={2} />
					<ellipse cx={15} cy={7} rx={4} ry={3} fill={INK} />
				</g>
			) : null}
			{L.sleepMask ? (
				<g transform="rotate(-6 0 -204)">
					<path d="M -52 -198 Q 0 -222 52 -198" fill="none" stroke="#1a1922" strokeWidth={6} />
					<rect x={-36} y={-226} width={72} height={28} rx={14} fill="#1a1922" {...OUT} />
					<path d="M -26 -212 q 8 6 16 0 M 10 -212 q 8 6 16 0" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" />
					<path d="M -36 -224 q 6 -6 12 0 q 6 -6 12 0 q 6 -6 12 0 q 6 -6 12 0 q 6 -6 12 0 q 6 -6 12 0" fill="#fff" stroke={INK} strokeWidth={1.5} />
					<circle cx={50} cy={-190} r={6} fill="#d8d8e0" {...OUT} strokeWidth={2} />
				</g>
			) : null}
			{L.tiara ? (
				<path d="M -18 -212 L -12 -232 L -4 -218 L 0 -238 L 4 -218 L 12 -232 L 18 -212 Z" fill="#d9a83e" {...OUT} strokeWidth={2.2} />
			) : null}
		</g>
	);

	const ahoge = L.ahoge ? (
		<g transform={`rotate(${sway * 3} 0 -214)`}>
			<path d="M 0 -214 C 4 -240 28 -246 22 -228" fill="none" stroke={INK} strokeWidth={9} strokeLinecap="round" />
			<path d="M 0 -214 C 4 -240 28 -246 22 -228" fill="none" stroke={L.hair} strokeWidth={4.5} strokeLinecap="round" />
		</g>
	) : null;

	const braid = () => {
		if (L.style !== 'braid') return null;
		return (
			<g transform={`rotate(${sway} -46 -130)`}>
				{[0, 1, 2, 3, 4].map((i) => (
					<ellipse key={i} cx={-48 - i * 1.5} cy={-124 + i * 15} rx={11 - i * 0.6} ry={10} fill={hairFill} {...OUT} strokeWidth={2.4} />
				))}
				<path d="M -56 -54 l -8 -8 l 0 14 Z M -56 -54 l 8 -8 l 0 14 Z" fill="#7f9cff" {...OUT} strokeWidth={1.8} />
				<path d="M -56 -50 l -2 18" stroke="#7f9cff" strokeWidth={4} strokeLinecap="round" />
			</g>
		);
	};

	const arm = (side: -1 | 1, hand: {x: number; y: number}) => {
		const sx = side * 22;
		const hx = sx + hand.x;
		const hy = shoulderY + hand.y;
		const holds = prop !== 'none' && ((propHand === 'R' && side === 1) || (propHand === 'L' && side === -1));
		return (
			<g key={side}>
				<path d={`M ${sx} ${shoulderY} L ${hx} ${hy}`} stroke={INK} strokeWidth={16} strokeLinecap="round" />
				<path d={`M ${sx} ${shoulderY} L ${hx} ${hy}`} stroke={L.sleeve} strokeWidth={11} strokeLinecap="round" />
				{holds ? (
					<g transform={`translate(${hx} ${hy}) rotate(${propRot})`}>
						<PropShape prop={prop} frame={frame} />
					</g>
				) : null}
				<circle cx={hx} cy={hy} r={7.5} fill={SKIN} {...OUT} strokeWidth={2.2} />
			</g>
		);
	};

	return (
		<g transform={`translate(${x} ${y})`} opacity={opacity}>
			{shadow ? <ellipse cx={0} cy={2} rx={48} ry={9} fill="#000" opacity={0.13} /> : null}
			<g transform={`translate(0 ${bodyBob}) scale(${(flip ? -1 : 1) * scale * (1 - squash * 0.5)} ${scale * (1 + squash)}) rotate(${tilt})`}>
				<defs>
					<linearGradient id={`hair${uid}`} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0.35" stopColor={L.hair} />
						<stop offset="1" stopColor={L.hairTip} />
					</linearGradient>
				</defs>
				{wings()}
				{tail()}
				{backHair()}
				{twinTails()}
				{leg(-1)}
				{leg(1)}
				{/* 斗篷后片 */}
				{L.cloak ? <path d="M -26 -98 C -52 -86 -60 -50 -64 -16 L 64 -16 C 60 -50 52 -86 26 -98 Z" fill={L.cloak} {...OUT} /> : null}
				{/* 裙子 */}
				<path
					d={`M -24 -64 L 24 -64 C 34 -44 ${hemW - 6} ${hemY - 14} ${hemW} ${hemY} Q 0 ${hemY + 8} ${-hemW} ${hemY} C ${-hemW + 6} ${hemY - 14} -34 -44 -24 -64 Z`}
					fill={L.skirt}
					{...OUT}
				/>
				{L.skirtPanel ? (
					longSkirt ? (
						<path d={`M -9 -64 L 9 -64 L 18 ${hemY + 3} Q 0 ${hemY + 6} -18 ${hemY + 3} Z`} fill={L.skirtPanel} {...OUT} strokeWidth={2} />
					) : (
						<path d={`M ${-hemW + 2} ${hemY - 2} Q 0 ${hemY + 6} ${hemW - 2} ${hemY - 2} L ${hemW + 4} ${hemY + 6} Q 0 ${hemY + 16} ${-hemW - 4} ${hemY + 6} Z`} fill={L.skirtPanel} {...OUT} strokeWidth={2} />
					)
				) : null}
				<path d={`M ${-hemW + 1} ${hemY - 1} Q 0 ${hemY + 7} ${hemW - 1} ${hemY - 1}`} fill="none" stroke={L.hem} strokeWidth={5} />
				{L.apron ? (
					<g>
						<path d="M -18 -64 L 18 -64 L 26 -16 Q 0 -8 -26 -16 Z" fill="#fff" {...OUT} strokeWidth={2.4} />
						<path d="M -26 -16 q 6 6 13 1 q 6 6 13 1 q 6 6 13 1 q 6 6 13 -1" fill="#fff" stroke={INK} strokeWidth={2} />
						<path d="M -6 -40 q 6 -6 12 0 q -2 6 -8 6 Z" fill="#3a3f78" />
					</g>
				) : null}
				{/* 上身 */}
				<path d="M -21 -98 L 21 -98 L 25 -62 L -25 -62 Z" fill={L.top} {...OUT} />
				{L.corset ? <path d="M -22 -82 L 22 -82 L 25 -62 L -25 -62 Z" fill={L.corset} {...OUT} strokeWidth={2.4} /> : null}
				{L.apron ? <rect x={-12} y={-92} width={24} height={30} rx={4} fill="#fff" {...OUT} strokeWidth={2} /> : null}
				{L.cloak ? (
					<g>
						<path d="M -24 -98 C -40 -94 -46 -80 -42 -62 L -26 -66 L -14 -96 Z" fill={L.cloak} {...OUT} strokeWidth={2.4} />
						<path d="M 24 -98 C 40 -94 46 -80 42 -62 L 26 -66 L 14 -96 Z" fill={L.cloak} {...OUT} strokeWidth={2.4} />
					</g>
				) : null}
				<rect x={-6} y={-106} width={12} height={10} fill={SKIN_SHADE} />
				<path d="M 0 -95 L -12 -102 L -11 -88 Z M 0 -95 L 12 -102 L 11 -88 Z" fill={L.tie} {...OUT} strokeWidth={2} />
				<circle cx={0} cy={-95} r={3.5} fill={L.tie} {...OUT} strokeWidth={1.8} />
				{/* 头 */}
				<circle cx={0} cy={-158} r={64} fill={hairFill} {...OUT} />
				{ears()}
				<path d="M -52 -150 C -54 -110 -30 -96 0 -96 C 30 -96 54 -110 52 -150 Z" fill={SKIN} {...OUT} />
				{blush ? (
					<g opacity={0.75}>
						<ellipse cx={-34} cy={-113} rx={10} ry={5.5} fill={BLUSH} />
						<ellipse cx={34} cy={-113} rx={10} ry={5.5} fill={BLUSH} />
					</g>
				) : null}
				<Eye cx={-21} cy={-128} kind={eyeKind} iris={L.eyeL} side={-1} lookX={lookX} seed={frame / 10} />
				<Eye cx={21} cy={-128} kind={eyeKind === 'wink' ? 'wink' : eyeKind} iris={L.eyeR} side={1} lookX={lookX} seed={frame / 10} />
				<MouthShape kind={mouth} />
				{/* 刘海 */}
				<path
					d={`M -64 -150 C -70 -204 -34 -226 0 -226 C 34 -226 70 -204 64 -150 C 62 -132 58 -112 54 -98 C 50 -118 50 -138 46 -154 C 44 -150 40 -146 36 -144 C 38 -156 36 -166 30 -172 C 30 -158 26 -148 16 -138 C 16 -152 12 -164 6 -174 C 4 -160 -2 -150 -12 -140 C -12 -156 -16 -166 -22 -174 C -24 -160 -30 -150 -40 -144 C -40 -152 -42 -156 -46 -160 C -52 -138 -52 -118 -54 -98 C -58 -112 -62 -132 -64 -150 Z`}
					fill={hairFill}
					{...OUT}
				/>
				<path d="M -30 -206 q 12 -8 26 -6" fill="none" stroke="#fff" strokeWidth={4} strokeLinecap="round" opacity={0.55} />
				{ahoge}
				{accessories()}
				{braid()}
				{arm(-1, handL)}
				{arm(1, handR)}
				{sweat ? <path d="M 58 -170 q 8 12 0 18 q -8 -6 0 -18 Z" fill="#9fd8ff" stroke={INK} strokeWidth={2} /> : null}
			</g>
		</g>
	);
};
