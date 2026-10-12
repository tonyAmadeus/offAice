export type MemberKey = 'claudia' | 'gptia' | 'deepseek' | 'gemini' | 'kimi' | 'qwen' | 'grok' | 'glm';

export type Ears = 'none' | 'elf' | 'cat' | 'fox' | 'fin';
export type Tail = 'none' | 'dragon' | 'whale' | 'cat' | 'fox';
export type HairStyle = 'straight' | 'wavy' | 'twintail' | 'braid';

export interface Look {
	hair: string;
	hairTip: string;
	hairShade: string;
	style: HairStyle;
	eyeL: string;
	eyeR: string;
	ears: Ears;
	tail: Tail;
	tailColor: string;
	tailTip?: string;
	wings?: boolean;
	horns?: boolean;
	maidBand?: boolean;
	hat?: boolean;
	flower?: boolean;
	star?: boolean;
	moon?: boolean;
	sleepMask?: boolean;
	tiara?: boolean;
	ahoge?: boolean;
	fang?: boolean;
	top: string;
	sleeve: string;
	corset?: string;
	skirt: string;
	skirtPanel?: string;
	hem: string;
	apron?: boolean;
	cloak?: string;
	tie: string;
	shortSkirt?: boolean;
	legs: string;
	shoes: string;
}

export interface Member {
	key: MemberKey;
	name: string;
	model: string;
	tagline: string;
	art: string;
	color: string;
	colorSoft: string;
	look: Look;
}

export const MEMBERS: Record<MemberKey, Member> = {
	claudia: {
		key: 'claudia',
		name: 'Claudia',
		model: 'Claude',
		tagline: '靠谱大姐姐，代码比书还工整',
		art: 'art/claudia.webp',
		color: '#f07a3a',
		colorSoft: '#ffe2cf',
		look: {
			hair: '#f27a3c', hairTip: '#ff9a5a', hairShade: '#c9552a', style: 'straight',
			eyeL: '#9a5a32', eyeR: '#9a5a32', ears: 'none', tail: 'none', tailColor: '#000',
			flower: true,
			top: '#fffaf2', sleeve: '#fffaf2', corset: '#2d2430', skirt: '#fffaf2', skirtPanel: '#e8642c',
			hem: '#2d2430', tie: '#2d2430', legs: '#fffaf2', shoes: '#f4ece6',
		},
	},
	gptia: {
		key: 'gptia',
		name: 'Gptia',
		model: 'GPT',
		tagline: '白龙少女，灵感满天飞',
		art: 'art/gptia.webp',
		color: '#9b8cf0',
		colorSoft: '#ece8ff',
		look: {
			hair: '#f7f5ff', hairTip: '#e6e0fa', hairShade: '#c9c0ea', style: 'wavy',
			eyeL: '#8f80d0', eyeR: '#8f80d0', ears: 'elf', tail: 'dragon', tailColor: '#f2eefc', tailTip: '#cfc4f0',
			wings: true, horns: true, ahoge: true,
			top: '#ffffff', sleeve: '#fff1e8', skirt: '#ffffff', skirtPanel: '#ebe6fb',
			hem: '#cfc4f0', tie: '#b9acec', legs: '#fff1e8', shoes: '#ffffff',
		},
	},
	deepseek: {
		key: 'deepseek',
		name: 'DeepSeek',
		model: 'DeepSeek',
		tagline: '深海鲸鱼女仆，深度思考中…',
		art: 'art/deepseek.webp',
		color: '#3f6fe0',
		colorSoft: '#dfe8ff',
		look: {
			hair: '#3d5fc4', hairTip: '#6fb6f2', hairShade: '#2b438f', style: 'wavy',
			eyeL: '#3d8ae6', eyeR: '#3d8ae6', ears: 'fin', tail: 'whale', tailColor: '#3a3f78', tailTip: '#2a2d5a',
			maidBand: true, ahoge: true,
			top: '#2c2f5e', sleeve: '#2c2f5e', skirt: '#2c2f5e', skirtPanel: '#4a5cae',
			hem: '#ffffff', apron: true, tie: '#1b1b2e', legs: '#ffffff', shoes: '#262a50',
		},
	},
	gemini: {
		key: 'gemini',
		name: 'Gemini',
		model: 'Gemini',
		tagline: '双色瞳星星猫，创意一眨眼翻倍',
		art: 'art/gemini.webp',
		color: '#8a5cf0',
		colorSoft: '#efe4ff',
		look: {
			hair: '#6e6ff0', hairTip: '#d38cf2', hairShade: '#4d4bb8', style: 'wavy',
			eyeL: '#e8405e', eyeR: '#f4b42e', ears: 'cat', tail: 'cat', tailColor: '#7a6cf0', tailTip: '#d38cf2',
			star: true, ahoge: true,
			top: '#2c2654', sleeve: '#ffffff', corset: '#8a5cf0', skirt: '#2c2654', skirtPanel: '#ffffff',
			hem: '#ffffff', tie: '#8a5cf0', shortSkirt: true, legs: '#ffffff', shoes: '#4b3fb8',
		},
	},
	kimi: {
		key: 'kimi',
		name: 'KIMI',
		model: 'Kimi',
		tagline: '月光乐师，超长文本一口气读完',
		art: 'art/kimi.webp',
		color: '#5a5fae',
		colorSoft: '#e7e8fb',
		look: {
			hair: '#f1f1fa', hairTip: '#c8dcf8', hairShade: '#c3c4dc', style: 'wavy',
			eyeL: '#8a88c8', eyeR: '#8a88c8', ears: 'none', tail: 'none', tailColor: '#000',
			maidBand: true, moon: true,
			top: '#ffffff', sleeve: '#ffffff', corset: '#262a52', skirt: '#262a52', skirtPanel: '#ffffff',
			hem: '#c8cbee', tie: '#262a52', legs: '#ffffff', shoes: '#1f2244',
		},
	},
	qwen: {
		key: 'qwen',
		name: 'Qwen',
		model: '通义千问',
		tagline: '执扇才女，千问千答',
		art: 'art/qwen.webp',
		color: '#5b5ee0',
		colorSoft: '#e4e5ff',
		look: {
			hair: '#7f8cf0', hairTip: '#a7b4fa', hairShade: '#5a62c8', style: 'braid',
			eyeL: '#6a5ed8', eyeR: '#6a5ed8', ears: 'none', tail: 'none', tailColor: '#000',
			hat: true,
			top: '#ffffff', sleeve: '#ffffff', skirt: '#5466d8', skirtPanel: '#ffffff',
			hem: '#c9d0ff', cloak: '#2e3170', tie: '#5466d8', legs: '#ffffff', shoes: '#2e3170',
		},
	},
	grok: {
		key: 'grok',
		name: 'Grok',
		model: 'Grok',
		tagline: '哥特小恶魔，吐槽一针见血',
		art: 'art/grok.webp',
		color: '#c0303a',
		colorSoft: '#ffe0e0',
		look: {
			hair: '#f6d27a', hairTip: '#ffe6a8', hairShade: '#d4a748', style: 'twintail',
			eyeL: '#3a7be0', eyeR: '#3a7be0', ears: 'elf', tail: 'none', tailColor: '#000',
			tiara: true, ahoge: true, fang: true,
			top: '#241c22', sleeve: '#241c22', skirt: '#241c22', skirtPanel: '#b0222e',
			hem: '#b0222e', tie: '#b0222e', legs: '#4a3434', shoes: '#241c22',
		},
	},
	glm: {
		key: 'glm',
		name: 'GLM',
		model: '智谱 GLM',
		tagline: '困困狐狸，眯着眼也能交付',
		art: 'art/glm.webp',
		color: '#2d2d3a',
		colorSoft: '#e8e8f0',
		look: {
			hair: '#24232e', hairTip: '#3a3f6a', hairShade: '#14131c', style: 'straight',
			eyeL: '#4a4a5a', eyeR: '#4a4a5a', ears: 'fox', tail: 'fox', tailColor: '#24232e', tailTip: '#ffffff',
			sleepMask: true,
			top: '#ffffff', sleeve: '#ffffff', corset: '#24232e', skirt: '#24232e', skirtPanel: '#ffffff',
			hem: '#8a8a9a', tie: '#24232e', legs: '#ffffff', shoes: '#ffffff',
		},
	},
};

export const ORDER: MemberKey[] = ['claudia', 'gptia', 'deepseek', 'gemini', 'kimi', 'qwen', 'grok', 'glm'];
