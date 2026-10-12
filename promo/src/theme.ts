import {continueRender, delayRender, staticFile} from 'remotion';

// 字体随项目一起放在 public/fonts（均为 SIL OFL），渲染时不依赖外网。
const fontsReady = delayRender('加载字体');
const faces = [
	new FontFace('ZCOOL KuaiLe', `url(${staticFile('fonts/ZCOOLKuaiLe-Regular.ttf')})`),
	new FontFace('Fredoka', `url(${staticFile('fonts/Fredoka-SemiBold.ttf')})`, {weight: '600'}),
	new FontFace('Fredoka', `url(${staticFile('fonts/Fredoka-Bold.ttf')})`, {weight: '700'}),
];
Promise.all(faces.map((f) => f.load()))
	.then((loaded) => {
		loaded.forEach((f) => (document.fonts as unknown as Set<FontFace>).add(f));
		continueRender(fontsReady);
	})
	.catch((err) => {
		console.error(err);
		continueRender(fontsReady);
	});

export const FONT = `Fredoka, "ZCOOL KuaiLe", "WenQuanYi Zen Hei", sans-serif`;
export const CN_FONT = `"ZCOOL KuaiLe", "WenQuanYi Zen Hei", sans-serif`;

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

// 背景音乐节拍。换成正式 BGM 后按实际 BPM 和首拍位置修改，所有跟拍动画会一起对齐。
export const BPM = 128;
export const FIRST_BEAT_FRAME = 0;
export const BEAT_FRAMES = (FPS * 60) / BPM;

// 分镜时间轴（帧）。
export const SCENES = {
	intro: 180,
	arrivals: 480,
	work: 480,
	play: 360,
	finale: 300,
} as const;

export const TOTAL_FRAMES = Object.values(SCENES).reduce((a, b) => a + b, 0);

export const INK = '#3b2b3f';
export const SKIN = '#fff1e8';
export const SKIN_SHADE = '#f6d6c8';
export const BLUSH = '#ff9fb0';
export const PINK = '#ff6fa3';
export const CREAM = '#fff8ef';

/** 节拍脉冲：每拍开头为 1，随后衰减到 0。 */
export const beatPulse = (frame: number, decay = 0.35) => {
	const local = (frame - FIRST_BEAT_FRAME) / BEAT_FRAMES;
	if (local < 0) return 0;
	const phase = local - Math.floor(local);
	return Math.exp(-phase / decay);
};

/** 跟拍弹跳：落拍时在地面，拍间腾空。 */
export const beatHop = (frame: number, height = 1) => {
	const local = (frame - FIRST_BEAT_FRAME) / BEAT_FRAMES;
	const phase = local - Math.floor(local);
	return -Math.sin(phase * Math.PI) * height;
};
