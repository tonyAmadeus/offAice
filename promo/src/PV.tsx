import React from 'react';
import {AbsoluteFill, getStaticFiles, Html5Audio, interpolate, Sequence, staticFile} from 'remotion';
import {StripeWipe} from './fx';
import {Arrivals} from './scenes/Arrivals';
import {Finale} from './scenes/Finale';
import {Intro} from './scenes/Intro';
import {Play} from './scenes/Play';
import {Work} from './scenes/Work';
import {SCENES, TOTAL_FRAMES} from './theme';

export const BGM_FILE = 'bgm.mp3';
// 音乐从第几秒开始用（跳过前奏时调整）。
export const BGM_START_SECONDS = 0;

const hasBgm = () => getStaticFiles().some((f) => f.name === BGM_FILE);

const starts = (() => {
	let t = 0;
	const out: Record<keyof typeof SCENES, number> = {intro: 0, arrivals: 0, work: 0, play: 0, finale: 0};
	(Object.keys(SCENES) as (keyof typeof SCENES)[]).forEach((k) => {
		out[k] = t;
		t += SCENES[k];
	});
	return out;
})();

export const PV: React.FC = () => (
	<AbsoluteFill style={{background: '#fff'}}>
		<Sequence durationInFrames={SCENES.intro}>
			<Intro />
		</Sequence>
		<Sequence from={starts.arrivals} durationInFrames={SCENES.arrivals}>
			<Arrivals />
		</Sequence>
		<Sequence from={starts.work} durationInFrames={SCENES.work}>
			<Work />
		</Sequence>
		<Sequence from={starts.play} durationInFrames={SCENES.play}>
			<Play />
		</Sequence>
		<Sequence from={starts.finale} durationInFrames={SCENES.finale}>
			<Finale />
		</Sequence>
		<StripeWipe at={starts.arrivals} />
		<StripeWipe at={starts.work} />
		<StripeWipe at={starts.play} />
		<StripeWipe at={starts.finale} />
		{hasBgm() ? (
			<Html5Audio
				src={staticFile(BGM_FILE)}
				trimBefore={Math.round(BGM_START_SECONDS * 30)}
				volume={(f) => interpolate(f, [0, 15, TOTAL_FRAMES - 45, TOTAL_FRAMES], [0, 0.9, 0.9, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}
			/>
		) : null}
	</AbsoluteFill>
);
