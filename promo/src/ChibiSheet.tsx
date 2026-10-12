import React from 'react';
import {AbsoluteFill} from 'remotion';
import {Chibi} from './Chibi';
import {ORDER} from './members';

/** 角色设定对照表：调试 Q 版造型用。 */
export const ChibiSheet: React.FC = () => (
	<AbsoluteFill style={{background: '#ffe9f1'}}>
		<svg viewBox="0 0 1920 1080" width="100%" height="100%">
			{ORDER.map((k, i) => (
				<Chibi key={k} m={k} x={130 + (i % 4) * 330 + (i >= 4 ? 160 : 0)} y={i < 4 ? 480 : 980} scale={1.55} prop={k === 'claudia' ? 'book' : k === 'qwen' ? 'fan' : k === 'grok' ? 'axe' : 'none'} armR={k === 'grok' ? 30 : 20} mouth={k === 'grok' ? 'fang' : 'smile'} />
			))}
		</svg>
	</AbsoluteFill>
);
