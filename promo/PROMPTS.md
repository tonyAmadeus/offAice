# AIROOM 0.1 PV · 生图提示词

视频里所有人物和场景都改用生成的二次元插画。Remotion 只负责动起来：位移、弹跳、镜头推拉、特效、字幕、转场。

## 交付要求

- 文件放到 `promo/public/gen/`，**文件名按下表**（png）。
- **人物立绘**：1024×1536 竖图，全身，人物居中，四周留白。**背景透明最好**；做不到就用**纯绿 #00FF00 纯色背景**。不要地面阴影，不要文字，不要其他物件（除非提示词里写了道具）。
- **背景图**：1920×1080 横图，**画面里不要出现人物**。
- 每张人物图都请**附上该角色的原立绘作参考图**，保证发色、服装、配饰一致：
  Claudia → `Claudia.webp`，Gptia → `GPTIA.webp`，DeepSeek → `ds.webp`，Gemini → `GEMINI.webp`，KIMI → `KIMI.webp`，Qwen → `QWen.webp`，Grok → `Grok.webp`，GLM → `GLM.jpg`。
- 优先级：**P1 必需**（没有就无法成片），**P2 推荐**（缺了我会用 P1 的图代替）。

### 通用风格前缀

每条提示词前面都加上这一段：

```
anime illustration, Japanese 2D anime style, clean crisp lineart, cel shading, soft pastel colors, bright and cheerful, high detail, masterpiece, consistent with the reference character design,
```

人物立绘再在末尾加上：

```
, full body, single character, centered, plain solid #00FF00 green background (or transparent background), no shadow on the ground, no text, no watermark
```

---

## 一、背景（5 张，均 P1）

| 文件名 | 提示词 |
|---|---|
| `bg_office.png` | cozy modern anime office interior, morning sunlight through two large windows, light wooden floor, bookshelf, potted plants, pendant lamps, a closed wooden door in the center back wall, empty wall space above the door for a sign, warm cream walls, wide shot, eye-level, no people |
| `bg_desks.png` | anime office workspace, a row of four wooden desks facing the camera, each with a closed laptop seen from the back, mugs and small plants on desks, office chairs behind desks, big window in the background, wide shot, eye-level, no people |
| `bg_lounge.png` | anime office break room, pink sofa against a mint green wall, small coffee table, espresso machine on a counter, window with blue sky, cushions, warm and relaxing, wide shot, eye-level, no people |
| `bg_meeting.png` | anime office meeting room, a large BLANK whiteboard on the left half of the back wall (nothing written on it), lavender walls, window on the right, a few chairs, wide shot, eye-level, no people |
| `bg_roundtable.png` | anime room with a big round wooden table in the center foreground seen from the front, four empty chairs behind the table, pink pastel walls, two windows, pendant lamp above, wide shot, eye-level, no people |

---

## 二、人物立绘（33 张）

> 括号里是这张图在视频里的用途。“桌后”类图只需要**腰部以上**，我会把它放到背景里的桌子后面。

### Claudia（参考 `Claudia.webp`）

| 文件名 | 优先级 | 提示词 |
|---|---|---|
| `claudia_walk.png` | P1 | Claudia walking forward while reading an open book, calm gentle smile, one foot stepping (arrival) |
| `claudia_type.png` | P1 | Claudia from the waist up, typing on a laptop keyboard with both hands, focused serious expression, laptop seen from the back (desk scene) |
| `claudia_point.png` | P2 | Claudia holding a book in one arm and pointing to the side with the other hand, confident smile, like explaining a plan on a whiteboard (meeting) |
| `claudia_slam.png` | P1 | Claudia snapping her book shut loudly, comically angry face with a cartoon anger vein mark, slight motion lines (play scene, stops the chaos) |

### Gptia（参考 `GPTIA.webp`）

| 文件名 | 优先级 | 提示词 |
|---|---|---|
| `gptia_fly.png` | P1 | Gptia flying down from the sky with dragon wings spread wide, arms open, happy open-mouth smile, small blue cloud spirit next to her, feet off the ground (arrival) |
| `gptia_mug.png` | P2 | Gptia standing and holding a coffee mug, chatting with a cheerful smile, one hand raised as if saying "I have an idea!" (break room) |
| `gptia_cheer.png` | P2 | Gptia cheering with both arms raised, eyes closed in a happy ^^ smile (meeting / ending) |
| `gptia_laugh.png` | P1 | Gptia hovering in the air with wings flapping, laughing and pointing down at something funny (play scene) |

### DeepSeek（参考 `ds.webp`，鲸鱼女仆）

| 文件名 | 优先级 | 提示词 |
|---|---|---|
| `deepseek_surf.png` | P1 | DeepSeek riding a cartoon ocean wave like surfing, arms out for balance, excited open-mouth smile, whale tail swishing, water splashes and bubbles (arrival) |
| `deepseek_type.png` | P1 | DeepSeek from the waist up, typing on a laptop keyboard, focused with a tiny smile, laptop seen from the back (desk scene) |
| `deepseek_docs.png` | P2 | DeepSeek holding a stack of documents to her chest, nodding with a happy smile (meeting) |
| `deepseek_chair.png` | P1 | DeepSeek sitting on a rolling office chair, zooming sideways, both arms raised excitedly, hair blown back by speed, open-mouth laugh (play scene: chair race) |

### Gemini（参考 `GEMINI.webp`，星星猫）

| 文件名 | 优先级 | 提示词 |
|---|---|---|
| `gemini_pose.png` | P1 | Gemini jumping with a cat paw pose (one hand raised like a cat paw), winking, cat mouth smile, sparkling stars around (arrival) |
| `gemini_type.png` | P1 | Gemini from the waist up, typing on a laptop keyboard, cat ears perked, cheerful focused expression, laptop seen from the back (desk scene) |
| `gemini_paper.png` | P2 | Gemini holding up a sheet of drawing paper above her head with both hands, proud happy smile, back of the paper facing the viewer (round table) |
| `gemini_throw.png` | P1 | Gemini throwing a paper airplane, mischievous grin, tongue slightly out (play scene) |
| `gemini_run.png` | P1 | Gemini running away in a comedic panic, arms flailing, tears of laughter, sweat drops, speed lines (play scene) |

### KIMI（参考 `KIMI.webp`，月光乐师）

| 文件名 | 优先级 | 提示词 |
|---|---|---|
| `kimi_scroll.png` | P1 | KIMI walking while holding a scroll that unrolls into an extremely long paper trailing far behind her on the floor, calm happy smile, musical notes floating (arrival: long-context gag) |
| `kimi_notes.png` | P2 | KIMI holding a notebook and pen, taking notes, gentle smile (break room) |
| `kimi_paper.png` | P2 | KIMI holding up a sheet of paper above her head with both hands, happy smile, back of the paper facing the viewer (round table) |
| `kimi_flag.png` | P1 | KIMI waving a black-and-white checkered race flag energetically, cheering (play scene: chair race) |

### Qwen（参考 `QWen.webp`，执扇才女）

| 文件名 | 优先级 | 提示词 |
|---|---|---|
| `qwen_idea.png` | P1 | Qwen snapping open her folding fan, eyes sparkling with a sudden idea, a glowing light bulb above her head (arrival) |
| `qwen_chat.png` | P2 | Qwen holding her folding fan near her mouth, chatting with a sly smile (break room) |
| `qwen_paper.png` | P2 | Qwen holding up a sheet of paper above her head with both hands, happy smile, back of the paper facing the viewer (round table) |
| `qwen_chair.png` | P1 | Qwen sitting on a rolling office chair, zooming sideways, holding her hat with one hand, laughing, hair blown by speed (play scene: chair race) |

### Grok（参考 `Grok.webp`，哥特小恶魔）

| 文件名 | 优先级 | 提示词 |
|---|---|---|
| `grok_dizzy.png` | P1 | Grok with dizzy spiral eyes after bumping her head, a cartoon bump and little stars circling her head, holding her big X-shaped axe loosely (arrival gag) |
| `grok_grin.png` | P2 | Grok holding a coffee mug, cheeky fanged grin, one hand on hip (break room) |
| `grok_cheer.png` | P2 | Grok resting her big axe on her shoulder, cheering with a fanged open-mouth smile (meeting) |
| `grok_chase.png` | P1 | Grok running and chasing someone in a comedic way, waving a big fluffy pillow above her head (not the axe), comically angry face with a fang, a paper airplane stuck in her hair (play scene) |

### GLM（参考 `GLM.jpg`，困困狐狸）

| 文件名 | 优先级 | 提示词 |
|---|---|---|
| `glm_sleepy.png` | P1 | GLM walking sleepily with eyes closed, yawning, holding her Z book, a "Zzz" bubble, fox ears drooping (arrival) |
| `glm_sleepdesk.png` | P1 | GLM from the waist up, asleep with her head resting on folded arms on a desk surface, drool bubble, fox ears relaxed (desk scene: still delivers while asleep) |
| `glm_awake.png` | P1 | GLM suddenly wide awake, sparkling star-shaped eyes, fox ears and tail standing up, energetic fist pump (arrival / desk scene) |
| `glm_paper.png` | P2 | GLM holding up a sheet of paper above her head with both hands, sleepy content smile, back of the paper facing the viewer (round table) |

---

## 三、可选

| 文件名 | 说明 |
|---|---|
| `group.png` | 8 人二次元合照，办公室里比耶合影，横图 1920×1080。没有这张我就用 8 张原立绘拼合照 |
| `bgm.mp3` | 背景音乐，放 `promo/public/bgm.mp3`，并告诉我 BPM（不知道也没关系，我来测） |
