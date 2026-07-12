/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

// Tarot Spreads - 牌阵定义
// 每个 spread 定义抽牌数量和每个位置的解读含义
module.exports = [
  {
    id: 'single',
    name: '单张牌',
    nameEn: 'Single Card',
    description: '抽取一张牌，适合快速回答或每日运势',
    cardCount: 1,
    positions: [
      { name: '当前', nameEn: 'Present', description: '当下的核心能量或建议' }
    ]
  },
  {
    id: 'three-card',
    name: '三牌牌阵',
    nameEn: 'Three Card Spread',
    description: '过去、现在、未来——最经典的时间线牌阵',
    cardCount: 3,
    positions: [
      { name: '过去', nameEn: 'Past', description: '影响当前情况的过往因素' },
      { name: '现在', nameEn: 'Present', description: '当前的处境与核心能量' },
      { name: '未来', nameEn: 'Future', description: '可能的发展方向与结果' }
    ]
  },
  {
    id: 'relationship',
    name: '关系牌阵',
    nameEn: 'Relationship Spread',
    description: '分析双方在关系中的角色与互动',
    cardCount: 3,
    positions: [
      { name: '你', nameEn: 'You', description: '你在这段关系中的状态' },
      { name: '对方', nameEn: 'Partner', description: '对方在这段关系中的状态' },
      { name: '关系', nameEn: 'Relationship', description: '关系的整体动态与走向' }
    ]
  },
  {
    id: 'choice',
    name: '选择牌阵',
    nameEn: 'Choice Spread',
    description: '面临抉择时帮助分析各选项的利弊',
    cardCount: 3,
    positions: [
      { name: '选项A', nameEn: 'Option A', description: '第一个选择的影响与可能结果' },
      { name: '选项B', nameEn: 'Option B', description: '第二个选择的影响与可能结果' },
      { name: '建议', nameEn: 'Advice', description: '综合建议与需注意的关键' }
    ]
  },
  {
    id: 'body-mind-spirit',
    name: '身心灵牌阵',
    nameEn: 'Body-Mind-Spirit Spread',
    description: '从身体、心理、灵性三个层面获取指引',
    cardCount: 3,
    positions: [
      { name: '身体', nameEn: 'Body', description: '身体层面的状态与建议' },
      { name: '心智', nameEn: 'Mind', description: '心理与思维层面的状态与建议' },
      { name: '灵性', nameEn: 'Spirit', description: '灵性层面的指引与成长方向' }
    ]
  },
  {
    id: 'celtic-cross',
    name: '凯尔特十字',
    nameEn: 'Celtic Cross',
    description: '最经典的十牌大阵，全面分析问题的各个层面',
    cardCount: 10,
    positions: [
      { name: '现状', nameEn: 'Present', description: '当前的核心情况' },
      { name: '挑战', nameEn: 'Challenge', description: '面临的直接挑战或阻碍' },
      { name: '根基', nameEn: 'Foundation', description: '问题的深层根源' },
      { name: '过去', nameEn: 'Recent Past', description: '刚过去的影响因素' },
      { name: '可能结果', nameEn: 'Possible Outcome', description: '如维持现状的可能结果' },
      { name: '近期未来', nameEn: 'Near Future', description: '即将到来的发展' },
      { name: '自我', nameEn: 'Self', description: '你的态度与内在状态' },
      { name: '环境', nameEn: 'Environment', description: '外部环境与他人影响' },
      { name: '希望与恐惧', nameEn: 'Hopes & Fears', description: '内心深处的期望与忧虑' },
      { name: '最终结果', nameEn: 'Final Outcome', description: '最终走向与结论' }
    ]
  },
  {
    id: 'horseshoe',
    name: '马蹄铁牌阵',
    nameEn: 'Horseshoe Spread',
    description: '七牌牌阵，从过去到未来全面展开',
    cardCount: 7,
    positions: [
      { name: '过去', nameEn: 'Past', description: '过去的影响' },
      { name: '现在', nameEn: 'Present', description: '当前处境' },
      { name: '隐藏影响', nameEn: 'Hidden Influences', description: '未被察觉的因素' },
      { name: '阻碍', nameEn: 'Obstacles', description: '需要克服的障碍' },
      { name: '外部影响', nameEn: 'External Influences', description: '周围人与环境的作用' },
      { name: '建议', nameEn: 'Advice', description: '最佳行动方向' },
      { name: '结果', nameEn: 'Outcome', description: '最终结果' }
    ]
  },
  {
    id: 'yes-no',
    name: '是非牌阵',
    nameEn: 'Yes/No Spread',
    description: '简明回答是或否，适合快速决策',
    cardCount: 1,
    positions: [
      { name: '答案', nameEn: 'Answer', description: '正位=是/有利，逆位=否/不利' }
    ]
  }
];
