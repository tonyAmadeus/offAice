import React from 'react';
import {AbsoluteFill, Easing, interpolate, Sequence, useCurrentFrame} from 'remotion';
import {Chibi} from '../Chibi';
import {Bubble, Camera, Caption, clamp, Onomatopoeia, RoomBadge, Sparkle, Zzz, useSpring} from '../fx';
import {MEMBERS, type MemberKey} from '../members';
import {CoffeeMachine, Desk, Lamp, Plant, RoundTable, Room, Sofa, Whiteboard} from '../office/Office';
import {beatHop, CN_FONT, INK} from '../theme';

export const ROOM = 120;

export const Work: React.FC = () => (
	<AbsoluteFill>
		<Sequence durationInFrames={ROOM}>
			<Desks />
		</Sequence>
		<Sequence from={ROOM} durationInFrames={ROOM}>
			<Lounge />
		</Sequence>
		<Sequence from={ROOM * 2} durationInFrames={ROOM}>
			<ProjectRoom />
		</Sequence>
		<Sequence from={ROOM * 3} durationInFrames={ROOM}>
			<RoundTableRoom />
		</Sequence>
	</AbsoluteFill>
);

/** 镜头推入的入场效果：每个房间开头快速放大落位。 */
const usePunchIn = () => {
	const frame = useCurrentFrame();
	return interpolate(frame, [0, 10, ROOM], [1.12, 1.0, 1.05], {...clamp, easing: Easing.out(Easing.cubic)});
};

/* ---------- 1. 成员工位 ---------- */

const CodeWindow: React.FC<{x: number; y: number; m: MemberKey; doneAt: number; delay: number}> = ({x, y, m, doneAt, delay}) => {
	const frame = useCurrentFrame();
	const pop = useSpring(delay, {damping: 11, stiffness: 200});
	const color = MEMBERS[m].color;
	const progress = interpolate(frame, [delay + 4, doneAt], [0, 1], clamp);
	const lines = 6;
	const stamp = useSpring(doneAt, {damping: 7, stiffness: 260});
	return (
		<g transform={`translate(${x} ${y}) scale(${pop})`}>
			<rect x={-160} y={-110} width={320} height={210} rx={20} fill="#fff" stroke={INK} strokeWidth={5} />
			<rect x={-160} y={-110} width={320} height={40} rx={20} fill={color} stroke={INK} strokeWidth={5} />
			<rect x={-155} y={-80} width={310} height={12} fill={color} />
			{['#ff6f6f', '#ffd84a', '#8be3c4'].map((c, i) => (
				<circle key={c} cx={-134 + i * 22} cy={-90} r={7} fill={c} stroke={INK} strokeWidth={2.5} />
			))}
			<text x={40} y={-82} textAnchor="middle" fontFamily="Fredoka" fontWeight={700} fontSize={24} fill="#fff">
				{MEMBERS[m].name}
			</text>
			{Array.from({length: lines}).map((_, i) => {
				const lineP = Math.max(0, Math.min(1, progress * lines - i));
				const w = (90 + ((i * 53) % 150)) * lineP;
				return <rect key={i} x={-136 + (i % 3) * 20} y={-56 + i * 24} width={w} height={12} rx={6} fill={i % 2 ? color : '#b8c0dc'} />;
			})}
			<rect x={-136} y={88 - 16} width={272} height={10} rx={5} fill="#eef0f8" />
			<rect x={-136} y={88 - 16} width={272 * progress} height={10} rx={5} fill={color} />
			{frame >= doneAt ? (
				<g transform={`translate(110 -40) scale(${stamp}) rotate(-12)`}>
					<circle r={44} fill="#8be3c4" stroke={INK} strokeWidth={5} />
					<path d="M -18 0 l 12 14 l 24 -28" fill="none" stroke="#fff" strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" />
				</g>
			) : null}
		</g>
	);
};

const Laptop: React.FC<{x: number; y: number; color: string}> = ({x, y, color}) => (
	<g transform={`translate(${x} ${y})`}>
		<path d="M -60 0 L 60 0 L 50 -84 L -50 -84 Z" fill="#dfe3f2" stroke={INK} strokeWidth={4} strokeLinejoin="round" />
		<circle cx={0} cy={-44} r={12} fill={color} />
		<rect x={-70} y={-6} width={140} height={10} rx={5} fill="#c6cbe0" stroke={INK} strokeWidth={3} />
	</g>
);

const Desks: React.FC = () => {
	const frame = useCurrentFrame();
	const zoom = usePunchIn();
	const crew: {m: MemberKey; x: number; done: number}[] = [
		{m: 'claudia', x: 260, done: 70},
		{m: 'deepseek', x: 720, done: 82},
		{m: 'gemini', x: 1200, done: 92},
		{m: 'glm', x: 1660, done: 56},
	];
	return (
		<AbsoluteFill style={{background: '#fff3e6'}}>
			<Camera zoom={zoom}>
				<svg viewBox="0 0 1920 1080" width="100%" height="100%">
					<Room windows={[-200, 1760]} />
					<Lamp x={500} />
					<Lamp x={1420} />
					{crew.map(({m, x, done}, i) => {
						const typing = frame < done || m === 'glm';
						const t = frame + i * 3;
						const asleep = m === 'glm';
						return (
							<g key={m}>
								<CodeWindow x={x} y={420} m={m} doneAt={done} delay={4 + i * 5} />
								<Chibi
									m={m}
									x={x}
									y={866}
									scale={1.32}
									seed={i}
									armL={asleep ? 30 : typing ? 34 + Math.sin(t * 1.3) * 10 : 150}
									armR={asleep ? 30 : typing ? 34 + Math.cos(t * 1.5) * 10 : 150}
									eyes={asleep ? 'closed' : typing ? 'open' : 'happy'}
									mouth={asleep ? 'o' : typing ? 'flat' : 'open'}
									lookX={typing && !asleep ? Math.sin(t / 5) * 2 : 0}
									tilt={asleep ? 8 : 0}
									shadow={false}
								/>
								<Desk x={x} y={782} w={360} />
								<Laptop x={x + 108} y={782} color={MEMBERS[m].color} />
								{asleep ? <Zzz x={x + 60} y={600} /> : null}
								{!typing && !asleep ? <Sparkle x={x - 120} y={620} delay={done + 2} size={34} /> : null}
							</g>
						);
					})}
					<Plant x={960} y={1050} s={0.9} />
					<Onomatopoeia x={1520} y={300} text="睡着也交付？！" delay={60} size={56} color="#8be3c4" rot={-6} life={60} />
				</svg>
			</Camera>
			<RoomBadge index={1} label="成员工位" color="#ff9f7a" />
			<Caption text="一对一派活，专心干到底" delay={8} color="#ff9f7a" />
		</AbsoluteFill>
	);
};

/* ---------- 2. 茶歇室 ---------- */

const Lounge: React.FC = () => {
	const frame = useCurrentFrame();
	const zoom = usePunchIn();
	const crew: {m: MemberKey; x: number; line: string; at: number; flip?: boolean}[] = [
		{m: 'qwen', x: 420, line: '今天开个小会？', at: 8},
		{m: 'grok', x: 760, line: '先喝咖啡！', at: 30},
		{m: 'gptia', x: 1100, line: '我有个点子！', at: 52},
		{m: 'kimi', x: 1440, line: '我来记纪要～', at: 74},
	];
	const cheer = frame >= 96;
	return (
		<AbsoluteFill style={{background: '#e6fbf3'}}>
			<Camera zoom={zoom}>
				<svg viewBox="0 0 1920 1080" width="100%" height="100%">
					<Room wall="#e6fbf3" wallDark="#cdf3e4" floor="#f2c99c" windows={[120]} />
					<Lamp x={960} />
					<Sofa x={980} y={770} color="#ff9fbf" w={720} />
					<CoffeeMachine x={1740} y={760} />
					<Plant x={160} y={1000} s={1.1} />
					{crew.map(({m, x, line, at}, i) => {
						const talking = frame >= at && frame < at + 22;
						const hop = cheer ? beatHop(frame + i * 2, 26) : talking ? Math.sin((frame - at) / 2) * -6 : 0;
						return (
							<g key={m}>
								<Chibi
									m={m}
									x={x}
									y={940 + hop}
									scale={1.5}
									seed={i}
									prop={m === 'qwen' ? 'fan' : m === 'kimi' ? 'paper' : 'mug'}
									armR={cheer ? 150 : talking ? 110 : 50}
									armL={cheer ? 150 : 15}
									eyes={cheer ? 'happy' : talking ? 'happy' : 'open'}
									mouth={cheer ? 'open' : talking ? (Math.floor(frame / 3) % 2 ? 'open' : 'smile') : 'smile'}
									lookX={talking ? 0 : x < 900 ? 3 : -3}
								/>
								<Bubble x={x + 70} y={i % 2 ? 520 : 580} text={line} delay={at} life={40} size={46} tail="left" />
							</g>
						);
					})}
					{cheer
						? [300, 700, 1100, 1500].map((hx, i) => (
								<g key={hx} transform={`translate(${hx + 120} ${380 - ((frame - 96) * 3 + i * 10)})`} opacity={interpolate(frame, [96, 118], [1, 0], clamp)}>
									<path d="M 0 12 C -30 -10 -20 -34 0 -20 C 20 -34 30 -10 0 12 Z" fill="#ff6fa3" stroke={INK} strokeWidth={4} />
								</g>
							))
						: null}
				</svg>
			</Camera>
			<RoomBadge index={2} label="茶歇室" color="#3fbf98" />
			<Caption text="大家一起聊天、开会" delay={8} color="#3fbf98" />
		</AbsoluteFill>
	);
};

/* ---------- 3. 项目会议室 ---------- */

const ProjectRoom: React.FC = () => {
	const frame = useCurrentFrame();
	const zoom = usePunchIn();
	const colX = [30, 290, 550];
	const notes: {color: string; label: string; start: number}[] = [
		{color: '#ffd84a', label: '需求', start: 10},
		{color: '#9fd8ff', label: '设计', start: 24},
		{color: '#ffb2cf', label: '开发', start: 38},
		{color: '#b9f0d8', label: '测试', start: 52},
	];
	const stamp = useSpring(82, {damping: 7, stiffness: 240});
	return (
		<AbsoluteFill style={{background: '#eef0ff'}}>
			<Camera zoom={zoom}>
				<svg viewBox="0 0 1920 1080" width="100%" height="100%">
					<Room wall="#eef0ff" wallDark="#dde1fb" floor="#d8b08a" windows={[1500]} />
					<Whiteboard x={420} y={110} w={800} h={500}>
						{['待办', '进行中', '已完成'].map((t, i) => (
							<g key={t}>
								<text x={colX[i] + 110} y={62} textAnchor="middle" fontFamily={CN_FONT} fontSize={52} fill={INK}>
									{t}
								</text>
								{i > 0 ? <path d={`M ${colX[i] - 20} 20 V 460`} stroke="#d4d8ee" strokeWidth={4} strokeDasharray="10 10" /> : null}
							</g>
						))}
						{notes.map((n, i) => {
							const step1 = interpolate(frame, [n.start, n.start + 10], [0, 1], {...clamp, easing: Easing.out(Easing.back(1.6))});
							const step2 = interpolate(frame, [n.start + 24, n.start + 34], [0, 1], {...clamp, easing: Easing.out(Easing.back(1.6))});
							const x = colX[0] + 20 + (colX[1] - colX[0]) * (step1 + step2);
							const y = 96 + i * 98;
							const rot = Math.sin(i * 2) * 4 + (step1 % 1 ? 8 : 0);
							return (
								<g key={n.label} transform={`translate(${x} ${y}) rotate(${rot})`}>
									<rect width={200} height={84} rx={6} fill={n.color} stroke={INK} strokeWidth={4} />
									<text x={86} y={58} textAnchor="middle" fontFamily={CN_FONT} fontSize={46} fill={INK}>
										{n.label}
									</text>
									{step2 >= 1 ? <path d="M 162 18 l 8 10 l 14 -18" fill="none" stroke="#2f9e72" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" /> : null}
								</g>
							);
						})}
						{frame >= 82 ? (
							<g transform={`translate(260 300) scale(${stamp}) rotate(-14)`}>
								<rect x={-150} y={-56} width={300} height={112} rx={18} fill="none" stroke="#ff4d6d" strokeWidth={10} />
								<text textAnchor="middle" y={22} fontFamily={CN_FONT} fontSize={64} fill="#ff4d6d">
									验收通过
								</text>
							</g>
						) : null}
					</Whiteboard>
					<Chibi m="claudia" x={250} y={960} scale={1.6} prop="book" propHand="L" armL={40} armR={95 + Math.sin(frame / 5) * 8} eyes={frame > 82 ? 'happy' : 'open'} mouth={frame > 82 ? 'open' : 'smile'} lookX={4} />
					{(['deepseek', 'gptia', 'grok'] as MemberKey[]).map((m, i) => {
						const nod = Math.max(0, Math.sin((frame + i * 6) / 4)) * 4;
						const cheer = frame > 86;
						return (
							<Chibi
								key={m}
								m={m}
								x={1340 + i * 200}
								y={930 + (cheer ? beatHop(frame + i * 3, 24) : 0)}
								scale={1.3}
								seed={i + 2}
								tilt={cheer ? 0 : nod}
								armL={cheer ? 150 : 20}
								armR={cheer ? 150 : m === 'grok' ? 40 : 60}
								prop={m === 'grok' ? 'axe' : 'paper'}
								propRot={m === 'grok' ? 20 : 0}
								eyes={cheer ? 'happy' : 'open'}
								mouth={cheer ? (m === 'grok' ? 'fang' : 'open') : 'smile'}
								lookX={-4}
							/>
						);
					})}
					<Sparkle x={1000} y={300} delay={84} size={50} />
					<Sparkle x={460} y={520} delay={88} size={40} color="#ff6fa3" />
				</svg>
			</Camera>
			<RoomBadge index={3} label="项目会议室" color="#5b6ee8" />
			<Caption text="分工做项目，你来验收" delay={8} color="#5b6ee8" />
		</AbsoluteFill>
	);
};

/* ---------- 4. 圆桌 ---------- */

const Draft: React.FC<{x: number; y: number; letter: string; color: string; delay: number; variant: number}> = ({x, y, letter, color, delay, variant}) => {
	const frame = useCurrentFrame();
	const flip = interpolate(frame, [delay, delay + 8], [0, 1], clamp);
	const shown = flip > 0.5;
	const sx = Math.abs(Math.cos(flip * Math.PI));
	return (
		<g transform={`translate(${x} ${y}) scale(${sx} 1)`}>
			<rect x={-110} y={-140} width={220} height={260} rx={16} fill={shown ? '#fff' : color} stroke={INK} strokeWidth={5} />
			{shown ? (
				<g>
					<text x={-80} y={-92} fontFamily="Fredoka" fontWeight={700} fontSize={48} fill={color}>
						{letter}
					</text>
					{variant === 0 ? <circle cx={20} cy={0} r={56} fill={color} opacity={0.75} /> : null}
					{variant === 1 ? <rect x={-60} y={-50} width={130} height={110} rx={12} fill={color} opacity={0.75} /> : null}
					{variant === 2 ? <path d="M 0 -64 L 70 56 L -70 56 Z" fill={color} opacity={0.75} /> : null}
					{variant === 3 ? <path d="M -70 40 Q -30 -80 0 0 T 70 -40" fill="none" stroke={color} strokeWidth={18} strokeLinecap="round" /> : null}
					<rect x={-80} y={84} width={160} height={10} rx={5} fill="#d4d8ee" />
				</g>
			) : (
				<text x={0} y={30} textAnchor="middle" fontFamily="Fredoka" fontWeight={700} fontSize={110} fill="#fff" opacity={0.85}>
					?
				</text>
			)}
		</g>
	);
};

const RoundTableRoom: React.FC = () => {
	const frame = useCurrentFrame();
	const zoom = usePunchIn();
	const crew: MemberKey[] = ['gemini', 'kimi', 'qwen', 'glm'];
	const xs = [480, 800, 1120, 1440];
	const reveal = 46;
	const cursorX = interpolate(frame, [70, 82, 92, 102, 112], [1700, xs[0], xs[1], xs[2], xs[3]], {...clamp, easing: Easing.inOut(Easing.quad)});
	return (
		<AbsoluteFill style={{background: '#fff0f6'}}>
			<Camera zoom={zoom}>
				<svg viewBox="0 0 1920 1080" width="100%" height="100%">
					<Room wall="#fff0f6" wallDark="#ffe0ec" floor="#e2b48c" windows={[60, 1500]} />
					<Lamp x={960} />
					{crew.map((m, i) => {
						const revealed = frame >= reveal + i * 3;
						return (
							<Chibi
								key={m}
								m={m}
								x={xs[i]}
								y={790}
								scale={1.25}
								seed={i}
								armL={revealed ? 150 : 40}
								armR={revealed ? 150 : 40}
								eyes={revealed ? (m === 'glm' ? 'star' : 'happy') : 'closed'}
								mouth={revealed ? 'open' : 'flat'}
								shadow={false}
							/>
						);
					})}
					<RoundTable x={960} y={790} />
					{crew.map((m, i) => (
						<Draft key={m} x={xs[i]} y={430} letter={'ABCD'[i]} color={MEMBERS[m].color} delay={reveal + i * 3} variant={i} />
					))}
					{frame < reveal ? <Onomatopoeia x={960} y={240} text="不许偷看！" delay={6} size={70} color="#ff6fa3" rot={0} life={reveal - 6} /> : null}
					<Onomatopoeia x={960} y={240} text="同时公开！" delay={reveal} size={80} color="#ffb84a" rot={-4} life={30} />
					{frame >= 70 ? (
						<g transform={`translate(${cursorX + 40} ${560})`}>
							<path d="M 0 0 L 0 64 L 16 50 L 28 76 L 40 70 L 28 46 L 48 44 Z" fill="#fff" stroke={INK} strokeWidth={5} strokeLinejoin="round" />
						</g>
					) : null}
				</svg>
			</Camera>
			<RoomBadge index={4} label="圆桌" color="#ff6fa3" />
			<Caption text="各写一稿，挑你最爱的" delay={8} color="#ff6fa3" />
		</AbsoluteFill>
	);
};
