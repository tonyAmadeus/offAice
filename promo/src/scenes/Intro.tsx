import React from 'react';
import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {Bookshelf, Clock, Desk, Door, Lamp, Monitor, Plant, Room, Sign} from '../office/Office';
import {Camera, clamp, Onomatopoeia, Sparkle, Twinkles, useSpring} from '../fx';
import {CN_FONT, INK, PINK} from '../theme';

const LIGHTS_ON = 30;
const TITLE_AT = 72;

export const Intro: React.FC = () => {
	const frame = useCurrentFrame();
	const dark = frame < LIGHTS_ON - 4 ? 1 : frame < LIGHTS_ON - 2 ? 0.4 : frame < LIGHTS_ON ? 0.9 : interpolate(frame, [LIGHTS_ON, LIGHTS_ON + 6], [0.9, 0], clamp);
	const lampOn = 1 - dark;
	const flicker = [44, 47, 52, 55];
	const glow = frame < 42 ? 0 : flicker.some((f) => frame >= f && frame < f + 2) ? 0 : 1;
	const zoom = interpolate(frame, [0, TITLE_AT], [1.18, 1], {...clamp, easing: Easing.out(Easing.cubic)});
	const minutes = frame < LIGHTS_ON ? 8 * 60 + 59 : 9 * 60;
	const blur = interpolate(frame, [TITLE_AT - 4, TITLE_AT + 10], [0, 7], clamp);
	const veil = interpolate(frame, [TITLE_AT - 4, TITLE_AT + 10], [0, 0.55], clamp);

	return (
		<AbsoluteFill style={{background: '#16122a'}}>
			<Camera zoom={zoom} y={interpolate(frame, [0, TITLE_AT], [60, 0], clamp)}>
				<AbsoluteFill style={{filter: blur > 0 ? `blur(${blur}px)` : undefined}}>
					<svg viewBox="0 0 1920 1080" width="100%" height="100%">
						<Room windows={[120, 1440]} dark={dark} />
						<g opacity={1 - dark * 0.86}>
							<Lamp x={700} on={lampOn} />
							<Lamp x={1220} on={lampOn} />
						</g>
						<g opacity={1 - dark * 0.8}>
							<Bookshelf x={560} y={440} />
							<Plant x={1300} y={770} s={1.1} />
							<Door x={1000} y={760} />
							<Desk x={380} y={860} w={340} />
							<Monitor x={380} y={810} color="#ff9f7a" on={frame > LIGHTS_ON} />
							<Desk x={1600} y={860} w={340} />
							<Monitor x={1600} y={810} color="#7fb2ff" seed={3} on={frame > LIGHTS_ON} />
						</g>
						<Sign x={960} y={240} glow={glow} />
						<g style={{filter: dark > 0.5 ? 'drop-shadow(0 0 18px #ffe9a8)' : undefined}}>
							<Clock x={1300} y={520} minutes={minutes} r={60} />
						</g>
						<g transform="translate(1860 520)">
							<rect x={-26} y={-40} width={52} height={80} rx={10} fill="#fff" stroke={INK} strokeWidth={4} />
							<rect x={-10} y={frame < LIGHTS_ON - 4 ? 0 : -24} width={20} height={24} rx={4} fill={PINK} stroke={INK} strokeWidth={3} />
						</g>
						<Onomatopoeia x={1740} y={460} text="啪！" delay={LIGHTS_ON - 4} size={110} life={30} color="#ffd84a" />
						{frame >= LIGHTS_ON ? <Twinkles count={16} area={[200, 80, 1520, 600]} color="#fff6b8" /> : null}
					</svg>
				</AbsoluteFill>
			</Camera>
			<AbsoluteFill style={{background: `radial-gradient(circle at 50% 50%, rgba(255,214,232,${veil}), rgba(255,111,163,${veil}))`}} />
			{frame >= TITLE_AT - 2 ? <Title start={TITLE_AT} /> : null}
		</AbsoluteFill>
	);
};

const Title: React.FC<{start: number}> = ({start}) => {
	const frame = useCurrentFrame();
	const letters = 'AIROOM'.split('');
	const colors = ['#ff6fa3', '#ffb84a', '#7fb2ff', '#b39cff', '#8be3c4', '#ff8a64'];
	const sub = useSpring(start + 30, {damping: 12});
	const badge = useSpring(start + 44, {damping: 7, stiffness: 240});
	return (
		<AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', flexDirection: 'column'}}>
			<div style={{display: 'flex', gap: 6, marginTop: -60}}>
				{letters.map((ch, i) => {
					const s = useSpring(start + i * 4, {damping: 9, stiffness: 200});
					const hop = Math.sin(((frame - start - i * 4) / 30) * Math.PI * 2) * 6;
					return (
						<div
							key={i}
							style={{
								fontFamily: 'Fredoka',
								fontWeight: 700,
								fontSize: 250,
								lineHeight: 1,
								color: '#fff',
								WebkitTextStroke: `14px ${INK}`,
								paintOrder: 'stroke fill',
								textShadow: `0 16px 0 ${colors[i]}`,
								transform: `translateY(${(1 - s) * -700 + (frame > start + 40 ? hop : 0)}px) rotate(${(1 - s) * 30 * (i % 2 ? 1 : -1)}deg)`,
							}}
						>
							{ch}
						</div>
					);
				})}
			</div>
			<div
				style={{
					fontFamily: CN_FONT,
					fontSize: 92,
					color: INK,
					background: '#fff',
					border: `7px solid ${INK}`,
					borderRadius: 999,
					padding: '8px 60px 14px',
					marginTop: 30,
					transform: `scale(${sub})`,
					boxShadow: `0 12px 0 ${PINK}`,
					letterSpacing: 8,
				}}
			>
				我们的 AI 工作室
			</div>
			<div
				style={{
					position: 'absolute',
					right: 170,
					top: 110,
					width: 250,
					height: 250,
					borderRadius: '50%',
					background: '#ffd84a',
					border: `8px solid ${INK}`,
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
					transform: `scale(${badge}) rotate(${-14 + (1 - badge) * 90}deg)`,
					fontFamily: CN_FONT,
					color: INK,
					boxShadow: `0 10px 0 ${INK}`,
				}}
			>
				<div style={{fontFamily: 'Fredoka', fontWeight: 700, fontSize: 96, lineHeight: 1}}>0.1</div>
				<div style={{fontSize: 50}}>正式发布！</div>
			</div>
			<svg viewBox="0 0 1920 1080" width="100%" height="100%" style={{position: 'absolute', inset: 0}}>
				<Sparkle x={360} y={330} delay={start + 20} size={46} />
				<Sparkle x={1560} y={760} delay={start + 28} size={40} color="#7fb2ff" />
				<Sparkle x={420} y={780} delay={start + 36} size={34} color="#ff6fa3" />
				<Sparkle x={1500} y={300} delay={start + 60} size={30} />
			</svg>
		</AbsoluteFill>
	);
};
