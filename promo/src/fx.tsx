import React from 'react';
import {AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {CN_FONT, FONT, INK, PINK} from './theme';

export const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

export const useSpring = (delay: number, config: {damping?: number; stiffness?: number; mass?: number} = {}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	return spring({frame: frame - delay, fps, config: {damping: 12, stiffness: 160, ...config}});
};

export const Sparkle: React.FC<{x: number; y: number; size?: number; color?: string; delay?: number; life?: number}> = ({
	x,
	y,
	size = 30,
	color = '#ffd84a',
	delay = 0,
	life = 24,
}) => {
	const frame = useCurrentFrame();
	const t = (frame - delay) / life;
	if (t < 0 || t > 1) return null;
	const s = Math.sin(t * Math.PI) * size;
	return (
		<g transform={`translate(${x} ${y}) rotate(${t * 90})`}>
			<path d={`M 0 ${-s} Q ${s * 0.15} ${-s * 0.15} ${s} 0 Q ${s * 0.15} ${s * 0.15} 0 ${s} Q ${-s * 0.15} ${s * 0.15} ${-s} 0 Q ${-s * 0.15} ${-s * 0.15} 0 ${-s} Z`} fill={color} stroke={INK} strokeWidth={2.5} />
		</g>
	);
};

/** 循环闪烁的星星装饰。 */
export const Twinkles: React.FC<{count?: number; area?: [number, number, number, number]; color?: string; seed?: number}> = ({
	count = 12,
	area = [0, 0, 1920, 1080],
	color = '#fff',
	seed = 1,
}) => {
	const frame = useCurrentFrame();
	return (
		<g>
			{Array.from({length: count}).map((_, i) => {
				const r = (n: number) => {
					const v = Math.sin((i + 1) * 12.9898 * n + seed * 78.233) * 43758.5453;
					return v - Math.floor(v);
				};
				const x = area[0] + r(1) * area[2];
				const y = area[1] + r(2) * area[3];
				const period = 40 + r(3) * 40;
				const t = ((frame + r(4) * period) % period) / period;
				const s = Math.sin(t * Math.PI) * (10 + r(5) * 16);
				return (
					<path
						key={i}
						transform={`translate(${x} ${y})`}
						d={`M 0 ${-s} Q ${s * 0.15} ${-s * 0.15} ${s} 0 Q ${s * 0.15} ${s * 0.15} 0 ${s} Q ${-s * 0.15} ${s * 0.15} ${-s} 0 Q ${-s * 0.15} ${-s * 0.15} 0 ${-s} Z`}
						fill={color}
					/>
				);
			})}
		</g>
	);
};

/** 冲击放射线。 */
export const Burst: React.FC<{x: number; y: number; delay: number; color?: string; r?: number; rays?: number}> = ({x, y, delay, color = '#ffd84a', r = 90, rays = 10}) => {
	const frame = useCurrentFrame();
	const t = (frame - delay) / 14;
	if (t < 0 || t > 1) return null;
	const inner = r * (0.3 + t * 0.7);
	const outer = r * (0.6 + t * 0.8);
	return (
		<g transform={`translate(${x} ${y})`} opacity={1 - t}>
			{Array.from({length: rays}).map((_, i) => {
				const a = (i / rays) * Math.PI * 2;
				return (
					<path
						key={i}
						d={`M ${Math.cos(a) * inner} ${Math.sin(a) * inner} L ${Math.cos(a) * outer} ${Math.sin(a) * outer}`}
						stroke={color}
						strokeWidth={10}
						strokeLinecap="round"
					/>
				);
			})}
		</g>
	);
};

/** SVG 内的漫画拟声字。 */
export const Onomatopoeia: React.FC<{x: number; y: number; text: string; delay: number; color?: string; size?: number; rot?: number; life?: number}> = ({
	x,
	y,
	text,
	delay,
	color = '#ff5d7a',
	size = 90,
	rot = -10,
	life = 40,
}) => {
	const frame = useCurrentFrame();
	const pop = useSpring(delay, {damping: 8, stiffness: 260});
	if (frame < delay || frame > delay + life) return null;
	const fade = interpolate(frame, [delay + life - 8, delay + life], [1, 0], clamp);
	return (
		<g transform={`translate(${x} ${y}) rotate(${rot}) scale(${pop})`} opacity={fade}>
			<text
				textAnchor="middle"
				fontFamily={CN_FONT}
				fontSize={size}
				fill={color}
				stroke={INK}
				strokeWidth={size / 9}
				paintOrder="stroke"
				strokeLinejoin="round"
			>
				{text}
			</text>
		</g>
	);
};

/** SVG 对话气泡。 */
export const Bubble: React.FC<{x: number; y: number; text: string; delay: number; life?: number; w?: number; color?: string; tail?: 'left' | 'right'; size?: number}> = ({
	x,
	y,
	text,
	delay,
	life = 60,
	w,
	color = '#fff',
	tail = 'left',
	size = 40,
}) => {
	const frame = useCurrentFrame();
	const pop = useSpring(delay, {damping: 10, stiffness: 220});
	if (frame < delay || frame > delay + life) return null;
	const fade = interpolate(frame, [delay + life - 6, delay + life], [1, 0], clamp);
	const width = w ?? Math.max(110, text.length * size * 0.95 + 50);
	const h = size + 40;
	const tx = tail === 'left' ? -width / 2 + 40 : width / 2 - 40;
	return (
		<g transform={`translate(${x} ${y}) scale(${pop})`} opacity={fade}>
			<rect x={-width / 2} y={-h} width={width} height={h} rx={h / 2} fill={color} stroke={INK} strokeWidth={4} />
			<path d={`M ${tx - 14} -3 L ${tx + (tail === 'left' ? -18 : 18)} 24 L ${tx + 14} -3`} fill={color} stroke={INK} strokeWidth={4} strokeLinejoin="round" />
			<path d={`M ${tx - 12} -4 L ${tx + 12} -4`} stroke={color} strokeWidth={6} />
			<text x={0} y={-h / 2 + size * 0.36} textAnchor="middle" fontFamily={FONT} fontSize={size} fill={INK}>
				{text}
			</text>
		</g>
	);
};

export const Zzz: React.FC<{x: number; y: number; color?: string}> = ({x, y, color = '#7a7aa8'}) => {
	const frame = useCurrentFrame();
	return (
		<g>
			{[0, 1, 2].map((i) => {
				const t = ((frame + i * 18) % 54) / 54;
				return (
					<text
						key={i}
						x={x + t * 50 + i * 6}
						y={y - t * 90}
						fontFamily="Fredoka"
						fontWeight={700}
						fontSize={30 + t * 26}
						fill={color}
						stroke="#fff"
						strokeWidth={5}
						paintOrder="stroke"
						opacity={Math.sin(t * Math.PI)}
					>
						Z
					</text>
				);
			})}
		</g>
	);
};

export const Notes: React.FC<{x: number; y: number; color?: string}> = ({x, y, color = '#5a5fae'}) => {
	const frame = useCurrentFrame();
	return (
		<g>
			{[0, 1, 2, 3].map((i) => {
				const t = ((frame + i * 14) % 56) / 56;
				const nx = x + Math.sin(t * 6 + i) * 30 + (i - 1.5) * 50;
				const ny = y - t * 160;
				return (
					<g key={i} transform={`translate(${nx} ${ny}) rotate(${Math.sin(t * 8) * 15})`} opacity={Math.sin(t * Math.PI)}>
						<path d="M 0 0 V -34 L 22 -40 V -8" fill="none" stroke={color} strokeWidth={5} strokeLinejoin="round" />
						<ellipse cx={-6} cy={0} rx={9} ry={7} fill={color} />
						<ellipse cx={16} cy={-6} rx={9} ry={7} fill={color} />
					</g>
				);
			})}
		</g>
	);
};

export const SpeedLines: React.FC<{y: number; h: number; dir?: 1 | -1; color?: string; opacity?: number}> = ({y, h, dir = 1, color = '#fff', opacity = 0.8}) => {
	const frame = useCurrentFrame();
	return (
		<g opacity={opacity}>
			{Array.from({length: 14}).map((_, i) => {
				const ly = y + ((i * 53) % h);
				const len = 120 + ((i * 97) % 200);
				const x = ((((i * 211 + frame * 70) % 2400) + 2400) % 2400) - 240;
				const lx = dir === 1 ? x : 1920 - x;
				return <path key={i} d={`M ${lx} ${ly} h ${-dir * len}`} stroke={color} strokeWidth={6} strokeLinecap="round" />;
			})}
		</g>
	);
};

export const Confetti: React.FC<{count?: number; start?: number}> = ({count = 70, start = 0}) => {
	const frame = useCurrentFrame();
	const colors = ['#ff6fa3', '#ffd84a', '#7fb2ff', '#8be3c4', '#b39cff', '#ff9f7a'];
	const t = frame - start;
	if (t < 0) return null;
	return (
		<g>
			{Array.from({length: count}).map((_, i) => {
				const r = (n: number) => {
					const v = Math.sin((i + 1) * 91.17 * n) * 10000;
					return v - Math.floor(v);
				};
				const x = r(1) * 1920 + Math.sin(t / 10 + i) * 30;
				const y = -40 + ((t * (4 + r(2) * 5) + r(3) * 1100) % 1160);
				return (
					<rect
						key={i}
						x={x}
						y={y}
						width={14}
						height={22}
						rx={3}
						fill={colors[i % colors.length]}
						transform={`rotate(${t * (4 + r(4) * 8) + i * 30} ${x + 7} ${y + 11})`}
					/>
				);
			})}
		</g>
	);
};

/** 场景底部字幕条（HTML）。 */
export const Caption: React.FC<{text: string; sub?: string; delay?: number; color?: string; life?: number}> = ({text, sub, delay = 6, color = PINK, life}) => {
	const frame = useCurrentFrame();
	const pop = useSpring(delay, {damping: 11, stiffness: 180});
	const out = life ? interpolate(frame, [delay + life - 8, delay + life], [1, 0], clamp) : 1;
	return (
		<AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 54, pointerEvents: 'none'}}>
			<div
				style={{
					transform: `translateY(${(1 - pop) * 140}px) rotate(${(1 - pop) * -4}deg)`,
					opacity: out,
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					gap: 6,
				}}
			>
				<div
					style={{
						fontFamily: CN_FONT,
						fontSize: 76,
						color: '#fff',
						background: color,
						padding: '10px 46px 14px',
						borderRadius: 999,
						border: `6px solid ${INK}`,
						boxShadow: `0 10px 0 ${INK}`,
						whiteSpace: 'nowrap',
						letterSpacing: 4,
					}}
				>
					{text}
				</div>
				{sub ? (
					<div
						style={{
							fontFamily: CN_FONT,
							fontSize: 44,
							color: INK,
							background: '#fff',
							padding: '6px 30px 8px',
							borderRadius: 999,
							border: `5px solid ${INK}`,
							marginTop: 12,
							whiteSpace: 'nowrap',
						}}
					>
						{sub}
					</div>
				) : null}
			</div>
		</AbsoluteFill>
	);
};

/** 左上角房间名牌。 */
export const RoomBadge: React.FC<{label: string; index: number; color: string}> = ({label, index, color}) => {
	const pop = useSpring(0, {damping: 12});
	return (
		<div
			style={{
				position: 'absolute',
				left: 56,
				top: 48,
				transform: `translateX(${(1 - pop) * -420}px)`,
				display: 'flex',
				alignItems: 'center',
				gap: 18,
				fontFamily: CN_FONT,
			}}
		>
			<div
				style={{
					width: 96,
					height: 96,
					borderRadius: 26,
					background: color,
					border: `6px solid ${INK}`,
					color: '#fff',
					fontFamily: 'Fredoka',
					fontWeight: 700,
					fontSize: 58,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					transform: 'rotate(-6deg)',
				}}
			>
				{index}
			</div>
			<div
				style={{
					background: '#fff',
					border: `6px solid ${INK}`,
					borderRadius: 24,
					padding: '8px 30px 12px',
					fontSize: 60,
					color: INK,
					boxShadow: `8px 8px 0 ${color}`,
				}}
			>
				{label}
			</div>
		</div>
	);
};

/** 场景切换：彩色斜条纹扫过。 */
export const StripeWipe: React.FC<{at: number; dur?: number}> = ({at, dur = 18}) => {
	const frame = useCurrentFrame();
	const t = (frame - (at - dur / 2)) / dur;
	if (t < 0 || t > 1) return null;
	const colors = ['#ff6fa3', '#ffd84a', '#7fb2ff', '#b39cff', '#8be3c4'];
	const e = Easing.inOut(Easing.cubic)(t);
	return (
		<AbsoluteFill style={{pointerEvents: 'none'}}>
			<svg viewBox="0 0 1920 1080" width="100%" height="100%">
				<g transform="rotate(-20 960 540)">
					{colors.map((c, i) => {
						const cx = 960 + (e - 0.5) * 6800 + (2 - i) * 150;
						return <rect key={c} x={cx - 1500} y={-1200} width={3000} height={3480} fill={c} />;
					})}
				</g>
			</svg>
		</AbsoluteFill>
	);
};

export const Flash: React.FC<{at: number; dur?: number}> = ({at, dur = 10}) => {
	const frame = useCurrentFrame();
	const o = interpolate(frame, [at, at + 2, at + dur], [0, 1, 0], clamp);
	if (o <= 0) return null;
	return <AbsoluteFill style={{background: '#fff', opacity: o}} />;
};

/** 简单镜头：缩放 + 平移（作用于整层）。 */
export const Camera: React.FC<{zoom: number; x?: number; y?: number; shake?: number; children: React.ReactNode}> = ({zoom, x = 0, y = 0, shake = 0, children}) => {
	const frame = useCurrentFrame();
	const sx = shake ? Math.sin(frame * 2.7) * shake : 0;
	const sy = shake ? Math.cos(frame * 3.1) * shake : 0;
	return (
		<AbsoluteFill style={{transform: `translate(${x + sx}px, ${y + sy}px) scale(${zoom})`, transformOrigin: '50% 50%'}}>{children}</AbsoluteFill>
	);
};
