import crypto from 'node:crypto';

export const FLOOR_CALIBRATION_VERSION = 1;
export const FLOOR_CALIBRATION_METHOD = 'query-doc-p90';
export const FLOOR_MIN = 0.40;
export const FLOOR_MAX = 0.75;

const p1 = [
  '之前那个养鱼的插件，现在到底是关着、半开着还是彻底没了？',
  'B站那份登录凭证放哪儿了？现在能用它发评论吗？',
  '把旧笔记导进新库的那个搬运工具，现在还能调用吗？',
  '以前那套萝莉预设包还装着吗？',
  '做新插件之前，你该先提醒我干嘛？',
  '让你去找别的模型讨论方案，聊到什么程度才算收工？',
  '设计和写代码分别该找哪个模型？',
  '我改完文档准备收尾，有没有什么检查是必须跑的？',
  '从 B 站拉视频截图老报证书不对，咋整？',
  '我把插件源码改了，为啥体检数字还是老样子？',
  '我一般几点睡、几点起？',
  '我生日是哪天？',
];

const negatives = [
  '主人平时几点睡觉、几点起床？',
  '主人早餐通常吃什么，有没有忌口？',
  '主人的身高是多少厘米？',
  '主人现在体重多少公斤？',
  '主人家里有哪些家庭成员？',
  '主人现实中养了什么宠物？',
  '主人的家庭住址在哪里？',
  '主人每天怎样通勤上班？',
  '主人喝咖啡喜欢什么豆和做法？',
  '主人平时喝酒吗，酒量怎么样？',
  '主人每周做什么运动？',
  '主人最喜欢哪一部电影？',
  '主人最近在玩什么电子游戏？',
  '主人最常听什么音乐或歌手？',
  '主人通常去哪里购物？',
  '主人正在使用的手机是什么型号？',
  '主人有没有汽车，车型是什么？',
  '主人下一次假期从哪天开始？',
  '主人最近一次旅行去了哪里？',
  '主人最近一次体检结果怎么样？',
  '主人的医保属于哪一种？',
  '主人每个月工资是多少？',
  '主人每月要交多少房租？',
  '主人最近一个快递的单号是什么？',
  '主人通常一周点几次外卖？',
  '主人点外卖偏爱什么口味？',
  '主人有没有养猫，猫叫什么？',
  '主人有没有养狗，狗叫什么？',
  '主人所在城市今天是什么天气？',
  '主人最喜欢怎样过节日？',
];

const c = [
  '系统自带的那个蓝色终端，数文件有几行可信吗？',
  '读那份宿主补丁配置时库报不认识的标记，咋绕过去？',
  '那个几十路同时落盘的测试偶尔红一次，算回归吗？',
  '按目录加载技能时，附带的参考文件是相对哪个根找的？',
];

export const FLOOR_CALIBRATION_QUERIES = Object.freeze([...p1, ...negatives, ...c]);
export const FLOOR_CALIBRATION_SHA256 = crypto.createHash('sha256')
  .update(JSON.stringify(FLOOR_CALIBRATION_QUERIES))
  .digest('hex');

if (FLOOR_CALIBRATION_QUERIES.length !== 46) {
  throw new Error(`floor calibration must contain 46 queries, got ${FLOOR_CALIBRATION_QUERIES.length}`);
}
