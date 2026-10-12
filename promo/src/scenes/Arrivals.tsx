import React from 'react';
import {AbsoluteFill, Easing, Img, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {Chibi, type ChibiProps} from '../Chibi';
import {Burst, clamp, Notes, Onomatopoeia, Sparkle, Zzz, useSpring} from '../fx';
import {MEMBERS, ORDER, type MemberKey} from '../members';
import {CN_FONT, INK} from '../theme';

export const CARD = 60;
const OVERLAP = 8;

export const Arrivals: React.FC = () => (
	<AbsoluteFill style={{background: '#fff'}}>
		{ORDER.map((k, i) => (
			<Sequence key={k} from={i * CARD} durationInFrames={i === ORDER.length - 1 ? CARD : CARD + OVERLAP}>
				<MemberCard m={k} index={i} />
			</Sequence>
		))}
	</AbsoluteFill>
);

const FLOOR = 800;

const MemberCard: React.FC<{m: MemberKey; index: number}> = ({m, index}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const mem = MEMBERS[m];
	const mirror = index % 2 === 1;
	const enter = interpolate(frame, [0, OVERLAP], [1, 0], {...clamp, easing: Easing.out(Easing.cubic)});
	const art = spring({frame: frame - 3, fps, config: {damping: 14, stiffness: 120}});
	const name = spring({frame: frame - 8, fps, config: {damping: 11, stiffness: 170}});
	const tag = spring({frame: frame - 16, fps, config: {damping: 12, stiffness: 170}});
	const cx = mirror ? 760 : 1160;
	const floatY = Math.sin(frame / 12) * 8;

	return (
		<AbsoluteFill style={{transform: `translateX(${(mirror ? -1 : 1) * enter * 1920}px)`, overflow: 'hidden'}}>
			<AbsoluteFill style={{background: mem.colorSoft}} />
			<svg viewBox="0 0 1920 1080" width="100%" height="100%" style={{position: 'absolute', inset: 0}}>
				<defs>
					<pattern id={`dots${m}`} width={60} height={60} patternUnits="userSpaceOnUse" patternTransform={`translate(${frame * 1.5} ${frame * 1.5})`}>
						<circle cx={30} cy={30} r={6} fill={mem.color} opacity={0.18} />
					</pattern>
				</defs>
				<rect width={1920} height={1080} fill={`url(#dots${m})`} />
				<path d={mirror ? 'M 1100 0 L 1920 0 L 1920 1080 L 900 1080 Z' : 'M 0 0 L 820 0 L 1020 1080 L 0 1080 Z'} fill={mem.color} opacity={0.9} />
				<text
					x={mirror ? 1900 : 20}
					y={1050}
					textAnchor={mirror ? 'end' : 'start'}
					fontFamily="Fredoka"
					fontWeight={700}
					fontSize={260}
					fill="#fff"
					opacity={0.16}
				>
					{mem.name.toUpperCase()}
				</text>
				<ellipse cx={cx} cy={FLOOR + 6} rx={300} ry={40} fill="#fff" opacity={0.65} />
			</svg>
			<Img
				src={staticFile(mem.art)}
				style={{
					position: 'absolute',
					height: 1000,
					bottom: -40 + floatY,
					[mirror ? 'right' : 'left']: 90,
					transform: `translateY(${(1 - art) * 700}px) rotate(${(1 - art) * (mirror ? 8 : -8)}deg)`,
					filter: `drop-shadow(0 0 0 #fff) drop-shadow(10px 10px 0 ${INK}33)`,
				}}
			/>
			<svg viewBox="0 0 1920 1080" width="100%" height="100%" style={{position: 'absolute', inset: 0}}>
				<Gag m={m} cx={cx} />
			</svg>
			<div
				style={{
					position: 'absolute',
					top: 70,
					[mirror ? 'left' : 'right']: 90,
					display: 'flex',
					flexDirection: 'column',
					alignItems: mirror ? 'flex-start' : 'flex-end',
					transform: `translateX(${(1 - name) * (mirror ? -900 : 900)}px)`,
				}}
			>
				<div style={{display: 'flex', alignItems: 'center', gap: 20, flexDirection: mirror ? 'row' : 'row-reverse'}}>
					<div
						style={{
							fontFamily: 'Fredoka',
							fontWeight: 700,
							fontSize: 150,
							lineHeight: 1,
							color: '#fff',
							WebkitTextStroke: `12px ${INK}`,
							paintOrder: 'stroke fill',
							textShadow: `0 12px 0 ${mem.color}`,
						}}
					>
						{mem.name}
					</div>
				</div>
				<div
					style={{
						marginTop: 18,
						fontFamily: CN_FONT,
						fontSize: 44,
						color: '#fff',
						background: INK,
						borderRadius: 999,
						padding: '6px 28px 10px',
					}}
				>
					{`No.${index + 1} · ${mem.model}`}
				</div>
			</div>
			<div
				style={{
					position: 'absolute',
					bottom: 70,
					[mirror ? 'left' : 'right']: 90,
					fontFamily: CN_FONT,
					fontSize: 58,
					color: INK,
					background: '#fff',
					border: `6px solid ${INK}`,
					borderRadius: 28,
					padding: '12px 36px 16px',
					boxShadow: `10px 10px 0 ${mem.color}`,
					transform: `scale(${tag}) rotate(${mirror ? 2 : -2}deg)`,
					transformOrigin: mirror ? 'left center' : 'right center',
					whiteSpace: 'nowrap',
				}}
			>
				{mem.tagline}
			</div>
		</AbsoluteFill>
	);
};

const S = 2.1;

const Gag: React.FC<{m: MemberKey; cx: number}> = ({m, cx}) => {
	const f = useCurrentFrame();
	const land = useSpring(0, {damping: 13, stiffness: 120});
	const pop = useSpring(28, {damping: 7, stiffness: 220});
	const base: ChibiProps = {m, x: cx, y: FLOOR, scale: S, seed: 1};

	switch (m) {
		case 'claudia': {
			const x = interpolate(f, [0, 26], [cx + 520, cx], {...clamp, easing: Easing.out(Easing.quad)});
			const walking = f < 26;
			return (
				<g>
					<Chibi {...base} x={x} walk={walking ? f * 0.5 : undefined} prop="book" armR={walking ? 30 : 30 + pop * 75} armL={walking ? 10 : 40 * pop} eyes={f > 28 ? 'happy' : 'open'} mouth={f > 28 ? 'open' : 'smile'} propRot={walking ? 0 : -10} />
					<Sparkle x={cx + 170} y={FLOOR - 470} delay={30} size={40} />
					<Sparkle x={cx - 160} y={FLOOR - 380} delay={34} size={28} color="#ff9f7a" />
					<Onomatopoeia x={cx - 230} y={FLOOR - 470} text="准时到岗！" delay={30} size={64} color="#ff9f7a" rot={-6} />
				</g>
			);
		}
		case 'gptia': {
			const y = FLOOR - (1 - land) * 640;
			const flying = f < 24;
			const ox = Math.cos(f / 6) * 220;
			const oy = Math.sin(f / 6) * 50;
			return (
				<g>
					<Chibi {...base} y={y} flap={flying} armL={flying ? 70 : 150} armR={flying ? 70 : 150} eyes={flying ? 'open' : 'happy'} mouth={flying ? 'o' : 'open'} shadow={!flying} />
					<g transform={`translate(${cx + ox} ${FLOOR - 420 + oy})`}>
						<path d="M -36 10 q -14 -26 10 -34 q 6 -20 28 -14 q 22 -8 30 12 q 20 8 6 30 Z" fill="#a9c4ff" stroke={INK} strokeWidth={4} />
						<circle cx={-6} cy={-6} r={6} fill={INK} />
						<circle cx={14} cy={-6} r={6} fill={INK} />
						<circle cx={-4} cy={-8} r={2} fill="#fff" />
						<circle cx={16} cy={-8} r={2} fill="#fff" />
					</g>
					<Sparkle x={cx - 180} y={FLOOR - 300} delay={24} size={36} color="#c4b2ff" />
					<Sparkle x={cx + 200} y={FLOOR - 200} delay={28} size={30} color="#c4b2ff" />
				</g>
			);
		}
		case 'deepseek': {
			const x = interpolate(f, [0, 24], [cx - 760, cx], {...clamp, easing: Easing.out(Easing.cubic)});
			const surfing = f < 26;
			const waveX = x - 40;
			const waveH = interpolate(f, [0, 22, 36], [160, 140, 0], clamp);
			const wave = Math.sin(f / 3) * 10;
			return (
				<g>
					{waveH > 0 ? (
						<g>
							<path
								d={`M ${waveX - 900} ${FLOOR + 10} L ${waveX - 120} ${FLOOR + 10} C ${waveX - 40} ${FLOOR - waveH + wave} ${waveX + 120} ${FLOOR - waveH - 20} ${waveX + 180} ${FLOOR - waveH + 30} C ${waveX + 150} ${FLOOR - 20} ${waveX + 240} ${FLOOR + 10} ${waveX + 300} ${FLOOR + 10} L ${waveX + 300} ${FLOOR + 60} L ${waveX - 900} ${FLOOR + 60} Z`}
								fill="#6fb6f2"
								stroke={INK}
								strokeWidth={5}
							/>
							<path d={`M ${waveX + 40} ${FLOOR - waveH + 10} q 30 -30 60 -10 q 30 -30 70 6`} fill="none" stroke="#fff" strokeWidth={10} strokeLinecap="round" />
						</g>
					) : null}
					<Chibi {...base} x={x} y={FLOOR - (surfing ? waveH * 0.7 : 0)} tilt={surfing ? -12 : 0} armL={surfing ? 100 : 150 + Math.sin(f / 3) * 20} armR={surfing ? 100 : 30} eyes={surfing ? 'open' : 'happy'} mouth="open" />
					{[0, 1, 2, 3, 4].map((i) => {
						const t = ((f + i * 9) % 40) / 40;
						return <circle key={i} cx={cx - 220 + i * 110 + Math.sin(t * 8) * 14} cy={FLOOR - 40 - t * 520} r={10 + (i % 3) * 6} fill="#fff" fillOpacity={0.5} stroke="#6fb6f2" strokeWidth={4} opacity={1 - t} />;
					})}
				</g>
			);
		}
		case 'gemini': {
			const p = interpolate(f, [0, 22], [0, 1], clamp);
			const x = cx - 640 * (1 - p);
			const y = FLOOR - Math.sin(p * Math.PI) * 340;
			const landed = f >= 22;
			const squash = landed ? interpolate(f, [22, 26, 32], [-0.12, 0.06, 0], clamp) : 0;
			return (
				<g>
					{!landed
						? [4, 8, 12].map((d) => {
								const pp = Math.max(0, (f - d) / 22);
								return <Sparkle key={d} x={cx - 640 * (1 - pp)} y={FLOOR - 200 - Math.sin(pp * Math.PI) * 340} delay={f - 1} size={26} color="#c4b2ff" life={3} />;
							})
						: null}
					<Chibi {...base} x={x} y={y} squash={squash} armL={landed ? 20 : 120} armR={landed ? 165 : 120} eyes={landed ? 'wink' : 'happy'} mouth={landed ? 'cat' : 'open'} shadow={landed} />
					<Sparkle x={cx + 150} y={FLOOR - 520} delay={24} size={44} color="#ffd84a" />
					<Sparkle x={cx - 170} y={FLOOR - 460} delay={27} size={36} color="#e8405e" />
					<Sparkle x={cx + 210} y={FLOOR - 260} delay={30} size={30} color="#c4b2ff" />
					<Onomatopoeia x={cx + 220} y={FLOOR - 400} text="喵☆" delay={26} size={72} color="#b39cff" rot={10} />
				</g>
			);
		}
		case 'kimi': {
			const x = interpolate(f, [0, 26], [cx - 420, cx], {...clamp, easing: Easing.out(Easing.quad)});
			const walking = f < 26;
			const handX = x + 100;
			const paperEnd = cx - 2000;
			return (
				<g>
					<rect x={paperEnd} y={FLOOR - 30} width={handX - paperEnd - 40} height={44} fill="#fff6dc" stroke={INK} strokeWidth={4} />
					{Array.from({length: 18}).map((_, i) => (
						<path key={i} d={`M ${handX - 80 - i * 70} ${FLOOR - 16} h -50 M ${handX - 80 - i * 70} ${FLOOR - 2} h -36`} stroke="#b9a98a" strokeWidth={4} strokeLinecap="round" />
					))}
					<Chibi {...base} x={x} walk={walking ? f * 0.45 : undefined} prop="scroll" armR={walking ? 50 : 60} armL={walking ? 10 : 130} eyes={walking ? 'open' : 'happy'} mouth="smile" />
					{f > 24 ? <Notes x={cx + 40} y={FLOOR - 420} color="#5a5fae" /> : null}
					<Onomatopoeia x={cx - 260} y={FLOOR - 120} text="长～～～文本" delay={20} size={58} color="#8a88c8" rot={0} />
				</g>
			);
		}
		case 'qwen': {
			const flick = f >= 30;
			const marks = [
				[-230, -420],
				[220, -460],
				[-280, -220],
				[260, -260],
				[0, -560],
			];
			return (
				<g>
					<Chibi {...base} prop="fan" armR={flick ? 150 - pop * 30 : 100} propRot={flick ? 20 : -10} armL={20} eyes={flick ? 'happy' : 'open'} mouth={flick ? 'open' : 'o'} lookX={flick ? 0 : Math.sin(f / 4) * 3} />
					{marks.map(([dx, dy], i) => {
						const d = i * 4;
						const s = useSpring(d, {damping: 8, stiffness: 240});
						return (
							<g key={i} transform={`translate(${cx + dx} ${FLOOR + dy}) scale(${s}) rotate(${flick ? 0 : Math.sin((f + i * 5) / 4) * 12})`}>
								<text textAnchor="middle" y={30} fontFamily="Fredoka" fontWeight={700} fontSize={100} fill={flick ? '#ffb84a' : '#7f8cf0'} stroke={INK} strokeWidth={10} paintOrder="stroke">
									{flick ? '!' : '?'}
								</text>
							</g>
						);
					})}
					{flick ? (
						<g transform={`translate(${cx} ${FLOOR - 640}) scale(${pop})`}>
							<circle r={44} fill="#ffe76a" stroke={INK} strokeWidth={5} />
							<rect x={-18} y={38} width={36} height={24} rx={6} fill="#cfd3e6" stroke={INK} strokeWidth={4} />
							<path d="M -12 10 l 12 -16 l 12 16" fill="none" stroke="#ffb84a" strokeWidth={5} />
						</g>
					) : null}
					<Burst x={cx} y={FLOOR - 640} delay={30} color="#ffd84a" r={110} />
				</g>
			);
		}
		case 'grok': {
			const hit = 18;
			const run = interpolate(f, [0, hit], [cx + 560, cx - 30], clamp);
			const bounce = f < hit ? 0 : interpolate(f, [hit, hit + 10], [0, 110], {...clamp, easing: Easing.out(Easing.quad)});
			const x = run + bounce;
			const dizzy = f >= hit && f < hit + 18;
			const proud = f >= hit + 18;
			const pillar = cx - 300;
			return (
				<g>
					<rect x={pillar - 30} y={FLOOR - 640} width={60} height={650} rx={8} fill="#c98b5a" stroke={INK} strokeWidth={5} />
					<rect x={pillar - 60} y={FLOOR - 680} width={600} height={60} rx={10} fill="#d89a68" stroke={INK} strokeWidth={5} />
					<Chibi
						{...base}
						x={x}
						walk={f < hit ? f * 0.8 : undefined}
						prop="axe"
						armR={proud ? 150 : 40}
						propRot={proud ? -10 : 30}
						armL={proud ? 30 : 20}
						eyes={dizzy ? 'dizzy' : proud ? 'happy' : 'angry'}
						mouth={dizzy ? 'wave' : 'fang'}
						tilt={dizzy ? Math.sin(f / 2) * 6 : 0}
						flip
					/>
					<Burst x={pillar + 30} y={FLOOR - 420} delay={hit} color="#ffd84a" r={120} />
					<Onomatopoeia x={pillar + 60} y={FLOOR - 480} text="哐！" delay={hit} size={120} color="#ff5d7a" rot={-14} life={22} />
					<Onomatopoeia x={cx + 200} y={FLOOR - 560} text="嘿嘿～" delay={hit + 20} size={70} color="#c0303a" rot={8} />
				</g>
			);
		}
		case 'glm': {
			const x = interpolate(f, [0, 34], [cx + 320, cx], clamp);
			const awake = f >= 36;
			return (
				<g>
					<Burst x={cx} y={FLOOR - 300} delay={36} color="#8be3c4" r={240} rays={14} />
					<Chibi {...base} x={x} walk={!awake ? f * 0.25 : undefined} tilt={awake ? 0 : Math.sin(f / 6) * 5} eyes={awake ? 'star' : 'closed'} mouth={awake ? 'open' : 'o'} armL={awake ? 150 : 10} armR={awake ? 150 : 10} squash={awake ? interpolate(f, [36, 40, 46], [0.1, -0.05, 0], clamp) : 0} />
					{!awake ? <Zzz x={x + 110} y={FLOOR - 470} /> : null}
					<Onomatopoeia x={cx + 230} y={FLOOR - 520} text="开挂！" delay={37} size={86} color="#8be3c4" rot={10} />
					<Sparkle x={cx - 200} y={FLOOR - 470} delay={38} size={40} color="#8be3c4" />
				</g>
			);
		}
	}
};
