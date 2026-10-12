import React from 'react';
import {Composition} from 'remotion';
import {PV} from './PV';
import {ChibiSheet} from './ChibiSheet';
import {FPS, HEIGHT, TOTAL_FRAMES, WIDTH} from './theme';

export const Root: React.FC = () => (
	<>
		<Composition id="AiroomPV" component={PV} durationInFrames={TOTAL_FRAMES} fps={FPS} width={WIDTH} height={HEIGHT} />
		<Composition id="ChibiSheet" component={ChibiSheet} durationInFrames={60} fps={FPS} width={WIDTH} height={HEIGHT} />
	</>
);
