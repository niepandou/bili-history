/* B站历史记录仪 —— 手机端 JS 分类器
   与电脑端 app_core/classifier.py 逻辑严格一致（同一套词典与优先级），
   保证同一条记录在两个端上得到相同分类。 */
"use strict";

// (id, 名称, 颜色)
const CATEGORIES = [
  ["game", "游戏", "#2f6fed"],
  ["code", "编程开发", "#5b4bdb"],
  ["tech", "数码评测", "#00a1d6"],
  ["knowledge", "知识科普", "#12a594"],
  ["study", "学习教育", "#e8a33d"],
  ["movie", "影视杂谈", "#c14a86"],
  ["anime", "动画番剧", "#f26d9b"],
  ["music", "音乐演奏", "#8a3ffc"],
  ["dance", "舞蹈颜值", "#e0559a"],
  ["food", "美食探店", "#d2542f"],
  ["life", "生活日常", "#3f9d5a"],
  ["funny", "搞笑鬼畜", "#f2a20c"],
  ["sport", "体育竞技", "#0f8fa8"],
  ["news", "新闻财经", "#c0472b"],
  ["ent", "娱乐综艺", "#d2458b"],
  ["other", "其他", "#8b93a7"],
];
const CAT_MAP = {}, CAT_NAME = {}, CAT_COLOR = {}, CAT_IDS = [];
CATEGORIES.forEach(([id, name, color]) => {
  CAT_MAP[id] = [id, name, color]; CAT_NAME[id] = name; CAT_COLOR[id] = color; CAT_IDS.push(id);
});

// B站原始分区 -> 一级分类
const ZONE_MAP = {
  "单机游戏": "game", "网络游戏": "game", "手机游戏": "game", "电子竞技": "game",
  "桌游棋牌": "game", "GMV": "game", "音游": "game", "手游": "game", "网游": "game",
  "245_free": "game",
  "编程": "code", "编程语言": "code", "计算机技术": "code", "软件应用": "code",
  "开源": "code", "开发者": "code",
  "数码": "tech", "极客DIY": "tech", "电脑装机": "tech", "汽车": "tech", "极客": "tech",
  "评测室": "tech", "科技": "tech",
  "科普": "knowledge", "野生技能协会": "knowledge", "社科人文": "knowledge",
  "职业职场": "knowledge", "设计创意": "knowledge", "纪录片": "knowledge",
  "医疗健康": "knowledge", "人文历史": "knowledge", "野生动物": "knowledge",
  "校园学习": "study", "考试": "study", "学习": "study", "考研": "study",
  "公开课": "study", "语言学习": "study",
  "影视": "movie", "影视杂谈": "movie", "影视剪辑": "movie", "短片": "movie",
  "预告·资讯": "movie", "电影": "movie", "电视剧": "movie", "放映厅": "movie",
  "动画": "anime", "番剧": "anime", "国创": "anime", "MAD·AMV": "anime",
  "手书": "anime", "配音": "anime", "手办": "anime", "二次元": "anime",
  "音乐": "music", "原创音乐": "music", "翻唱": "music", "演奏": "music",
  "VOCALOID·UTAU": "music", "音乐现场": "music", "MV": "music", "音乐综合": "music",
  "电音": "music", "说唱": "music",
  "舞蹈": "dance", "宅舞": "dance", "街舞": "dance", "中国舞": "dance",
  "舞蹈综合": "dance", "COS": "dance",
  "美食": "food", "美食制作": "food", "美食探店": "food", "美食侦探": "food",
  "家常菜": "food", "烘焙": "food",
  "生活": "life", "日常": "life", "动物圈": "life", "动物": "life", "萌宠": "life",
  "时尚": "life", "美妆": "life", "穿搭": "life", "VLOG": "life", "vlog": "life",
  "手工": "life", "亲子": "life", "旅行": "life", "户外": "life", "家居": "life",
  "搞笑": "funny", "鬼畜": "funny", "鬼畜调教": "funny", "音MAD": "funny",
  "人力VOCALOID": "funny", "梗": "funny", "沙雕": "funny",
  "体育": "sport", "运动": "sport", "足球": "sport", "篮球": "sport", "健身": "sport",
  "竞技": "sport", "综合体育": "sport", "田径": "sport", "游泳": "sport",
  "新闻": "news", "财经": "news", "股票": "news", "资讯": "news", "商业": "news",
  "宏观经济": "news", "时政": "news",
  "娱乐": "ent", "综艺": "ent", "明星": "ent", "颜值": "ent", "追星": "ent",
  "粉丝": "ent", "八卦": "ent",
};

// 标题关键词词典（自上而下，命中即返回；越具体越靠前）
const KEYWORD_RULES = [
  ["python", "code"], ["java", "code"], ["javascript", "code"], ["typescript", "code"],
  ["golang", "code"], ["rust", "code"], ["c++", "code"], ["c语言", "code"],
  ["算法", "code"], ["数据结构", "code"], ["leetcode", "code"], ["力扣", "code"],
  ["前端", "code"], ["后端", "code"], ["vue", "code"], ["react", "code"],
  ["spring", "code"], ["docker", "code"], ["kubernetes", "code"], ["linux", "code"],
  ["linux内核", "code"], ["git", "code"], ["程序员", "code"], ["代码", "code"],
  ["爬虫", "code"], ["数据库", "code"], ["mysql", "code"], ["redis", "code"],
  ["编译器", "code"], ["逆向", "code"], ["csdn", "code"], ["编程", "code"],
  ["开发板", "code"], ["嵌入式", "code"], ["单片机", "code"], ["ai大模型", "code"],
  ["深度学习", "code"], ["神经网络", "code"], ["llm", "code"], ["gpt", "code"],
  ["transformer", "code"], ["部署", "code"], ["框架", "code"], ["debug", "code"],
  ["考研", "study"], ["高考", "study"], ["四六级", "study"], ["雅思", "study"],
  ["托福", "study"], ["专升本", "study"], ["期末", "study"], ["期末复习", "study"],
  ["网课", "study"], ["讲义", "study"], ["期末速成", "study"], ["高数", "study"],
  ["线性代数", "study"], ["物理", "study"], ["化学", "study"], ["考研政治", "study"],
  ["公务员", "study"], ["行测", "study"], ["面试", "study"], ["论文", "study"],
  ["cpa", "study"], ["法考", "study"], ["日语", "study"], ["英语", "study"],
  ["学习", "study"], ["课堂", "study"], ["教程", "study"], ["入门到", "study"],
  ["a股", "news"], ["股市", "news"], ["基金", "news"], ["炒股", "news"],
  ["美联储", "news"], ["降息", "news"], ["财报", "news"], ["经济", "news"],
  ["房价", "news"], ["新闻", "news"], ["时政", "news"], ["军事", "news"],
  ["开箱", "tech"], ["评测", "tech"], ["装机", "tech"], ["显卡", "tech"],
  ["cpu", "tech"], ["手机评测", "tech"], ["router", "tech"], ["路由器", "tech"],
  ["nas", "tech"], ["机械键盘", "tech"], ["显示器", "tech"], ["耳机", "tech"],
  ["笔记本", "tech"], ["数码配件", "tech"], ["極客湾", "tech"], ["小白测评", "tech"],
  ["原神", "game"], ["崩铁", "game"], ["崩坏", "game"], ["王者", "game"],
  ["英雄联盟", "game"], ["lol", "game"], ["steam", "game"], ["switch", "game"],
  ["ps5", "game"], ["主机", "game"], ["通关", "game"], ["实况", "game"],
  ["攻略", "game"], ["抽卡", "game"], ["版本pv", "game"], ["我的世界", "game"],
  ["minecraft", "game"], ["塞尔达", "game"], ["暗区突围", "game"], ["三角洲", "game"],
  ["艾尔登法环", "game"], ["黑神话", "game"], ["第五人格", "game"], ["恐怖游戏", "game"],
  ["银河恶魔城", "game"], ["游戏", "game"], ["游戏杂谈", "game"], ["boss", "game"],
  ["足球", "sport"], ["篮球", "sport"], ["nba", "sport"], ["英超", "sport"],
  ["健身", "sport"], ["马拉松", "sport"], ["国足", "sport"], ["羽毛球", "sport"],
  ["乒乓球", "sport"], ["拳击", "sport"], ["ufc", "sport"], ["台球", "sport"],
  ["钢琴", "music"], ["吉他", "music"], ["翻唱", "music"], ["编曲", "music"],
  ["混音", "music"], ["乐谱", "music"], ["演唱会", "music"], ["mv", "music"],
  ["古筝", "music"], ["影视", "movie"], ["影评", "movie"], ["解说", "movie"],
  ["电影解说", "movie"], ["剧集", "movie"], ["预告", "movie"], ["影讯", "movie"],
  ["番剧", "anime"], ["动漫", "anime"], ["漫画", "anime"], ["mad", "anime"],
  ["手书", "anime"], ["动画短片", "anime"], ["国漫", "anime"],
  ["美食", "food"], ["探店", "food"], ["教程·食谱", "food"], ["烘焙", "food"],
  ["火锅", "food"], ["便当", "food"], ["做菜", "food"], ["试吃", "food"],
  ["vlog", "life"], ["个护", "life"], ["收纳", "life"], ["搬家", "life"],
  ["养猫", "life"], ["养狗", "life"], ["旅行", "life"], ["旅居", "life"],
  ["穿搭", "life"], ["化妆", "life"], ["护肤", "life"], ["装修", "life"],
  ["鬼畜", "funny"], ["搞笑", "funny"], ["整活", "funny"], ["沙雕", "funny"],
  ["meme", "funny"], ["梗百科", "funny"], ["爆笑", "funny"],
  ["科普", "knowledge"], ["纪录片", "knowledge"], ["原理", "knowledge"],
  ["为什么", "knowledge"], ["冷知识", "knowledge"], ["历史", "knowledge"],
  ["地理", "knowledge"], ["宇宙", "knowledge"], ["心理学", "knowledge"],
  ["天文", "knowledge"], ["冷门知识", "knowledge"],
  ["综艺", "ent"], ["舞台", "ent"], ["爱豆", "ent"], ["偶像", "ent"],
  ["直播回放", "ent"], ["pod", "ent"],
];

function classify(title, zone, author, customRules) {
  customRules = customRules || {};
  const text = ((title || "") + " " + (author || "")).toLowerCase();

  // 1. 用户自定义关键词规则（最长优先）
  const cks = Object.keys(customRules).sort((a, b) => b.length - a.length);
  for (const kw of cks) {
    if (text.includes(kw.toLowerCase()) && CAT_IDS.includes(customRules[kw])) {
      return [customRules[kw], "custom"];
    }
  }
  // 2. 标题关键词词典
  for (const [kw, cat] of KEYWORD_RULES) {
    if (text.includes(kw)) return [cat, "keyword"];
  }
  // 3. B站原始分区映射
  const z = (zone || "").trim();
  if (z) {
    if (ZONE_MAP[z]) return [ZONE_MAP[z], "zone"];
    for (const k in ZONE_MAP) {
      if (z.includes(k) || k.includes(z)) return [ZONE_MAP[k], "zone"];
    }
  }
  return ["other", "fallback"];
}

const Classifier = { CATEGORIES, CAT_MAP, CAT_NAME, CAT_COLOR, CAT_IDS, ZONE_MAP, KEYWORD_RULES, classify };
if (typeof module !== "undefined" && module.exports) module.exports = Classifier;
if (typeof window !== "undefined") window.Classifier = Classifier;
