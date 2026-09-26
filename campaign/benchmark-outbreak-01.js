// RALLY FRONTIER Campaign Mission · one mission = one JS file
(()=>{
  const mission = {
    "schemaVersion": 6,
    "missionId": "benchmark-outbreak-01",
    "title": "벤치마크 01 · 낮과 밤",
    "briefing": "안전기에는 외곽 군체 둥지를 제거하고, 위험기에는 중앙 기지로 돌아와 세 방향 공세를 막아라. 상용 RTS 캠페인 구조 재현을 위한 시스템 벤치마크 미션.",
    "faction": "flower",
    "seed": 46001,
    "player": {
      "units": [
        "shellbug",
        "stingbug",
        "dandelion",
        "thornfruit",
        "medic",
        "rootstalker"
      ],
      "defenseCards": [
        "thornTowerCard",
        "mortarTowerCard"
      ],
      "techCap": 2
    },
    "enemy": {
      "units": [
        "swarmbug",
        "rootstalker",
        "shelltitan"
      ],
      "defenseCards": [
        "thornTowerCard"
      ],
      "techCap": 3,
      "difficulty": "normal",
      "aiProfile": "scripted"
    },
    "presentation": {
      "opening": [
        "정찰대: 낮 동안에는 군체의 움직임이 눈에 띄게 줄어들어.",
        "지휘: 그때 외곽 둥지를 제거한다. 어두워지기 전에 반드시 기지로 돌아와.",
        "정찰대: 북쪽과 동쪽, 남서쪽에서 이동 흔적이 확인됐어. 세 방향 모두 대비해야 해."
      ],
      "outro": [
        "정찰대: 마지막 둥지가 무너졌어. 주변의 움직임도 멈췄다.",
        "지휘: 이 정도 규모가 자연스럽게 생긴 건 아닐 거다. 흔적을 더 조사한다."
      ]
    },
    "flags": {
      "night": false
    },
    "objectives": [
      {
        "id": "cleanse",
        "text": "군체 오염 둥지 24개를 모두 파괴하라",
        "state": "active"
      },
      {
        "id": "survive",
        "text": "위험기 동안 기지를 방어하라",
        "state": "hidden"
      }
    ],
    "regions": {
      "playerBase": {
        "center": [
          0.5,
          0.55
        ],
        "radius": 0.15
      },
      "northSector": {
        "center": [
          0.48,
          0.15
        ],
        "radius": 0.22
      },
      "eastSector": {
        "center": [
          0.84,
          0.51
        ],
        "radius": 0.2
      },
      "southSector": {
        "center": [
          0.53,
          0.84
        ],
        "radius": 0.22
      },
      "westSector": {
        "center": [
          0.15,
          0.52
        ],
        "radius": 0.22
      }
    },
    "map": {
      "type": "manual",
      "biome": "flower-border",
      "spawns": {
        "host": [
          0.5,
          0.55
        ],
        "guest": [
          0.93,
          0.08
        ]
      },
      "lanes": {
        "top": [
          [
            0.5,
            0.55
          ],
          [
            0.5,
            0.3
          ],
          [
            0.5,
            0.08
          ]
        ],
        "mid": [
          [
            0.5,
            0.55
          ],
          [
            0.73,
            0.52
          ],
          [
            0.95,
            0.52
          ]
        ],
        "bot": [
          [
            0.5,
            0.55
          ],
          [
            0.28,
            0.72
          ],
          [
            0.06,
            0.91
          ]
        ]
      },
      "capturePoints": [
        {
          "id": "north-expansion",
          "position": [
            0.62,
            0.27
          ],
          "lane": "top",
          "label": "북쪽 채집지"
        },
        {
          "id": "east-expansion",
          "position": [
            0.72,
            0.6
          ],
          "lane": "mid",
          "label": "동쪽 채집지"
        },
        {
          "id": "southwest-expansion",
          "position": [
            0.29,
            0.73
          ],
          "lane": "bot",
          "label": "남서 채집지"
        }
      ],
      "terrain": {
        "river": {
          "points": [
            [
              0.02,
              0.26
            ],
            [
              0.25,
              0.3
            ],
            [
              0.5,
              0.28
            ],
            [
              0.75,
              0.25
            ],
            [
              0.98,
              0.3
            ]
          ],
          "halfWidth": 0.025
        },
        "bridges": [
          {
            "id": "north-bridge",
            "position": [
              0.5,
              0.28
            ],
            "angle": 0,
            "halfLength": 0.06,
            "halfWidth": 0.02
          }
        ],
        "hills": [
          {
            "id": "base-north-ridge",
            "center": [
              0.5,
              0.42
            ],
            "rx": 0.12,
            "ry": 0.035,
            "height": 1
          }
        ]
      },
      "content": {
        "resourcePlacement": "objective-auto",
        "resourceAmounts": {
          "baseMineral": 900,
          "baseGas": 1800,
          "objectiveMineral": 800,
          "objectiveGas": 1600
        }
      },
      "structures": [
        {
          "id": "infest-01",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.28,
            0.16
          ],
          "label": "군체 오염 둥지 1",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-02",
          "building": "barracks",
          "faction": "enemy",
          "position": [
            0.36,
            0.13
          ],
          "label": "군체 오염 둥지 2",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-03",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.44,
            0.18
          ],
          "label": "군체 오염 둥지 3",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-04",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.53,
            0.12
          ],
          "label": "군체 오염 둥지 4",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-05",
          "building": "barracks",
          "faction": "enemy",
          "position": [
            0.61,
            0.18
          ],
          "label": "군체 오염 둥지 5",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-06",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.69,
            0.14
          ],
          "label": "군체 오염 둥지 6",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-07",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.79,
            0.32
          ],
          "label": "군체 오염 둥지 7",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-08",
          "building": "barracks",
          "faction": "enemy",
          "position": [
            0.86,
            0.39
          ],
          "label": "군체 오염 둥지 8",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-09",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.82,
            0.48
          ],
          "label": "군체 오염 둥지 9",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-10",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.89,
            0.56
          ],
          "label": "군체 오염 둥지 10",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-11",
          "building": "barracks",
          "faction": "enemy",
          "position": [
            0.8,
            0.63
          ],
          "label": "군체 오염 둥지 11",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-12",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.88,
            0.7
          ],
          "label": "군체 오염 둥지 12",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-13",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.3,
            0.82
          ],
          "label": "군체 오염 둥지 13",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-14",
          "building": "barracks",
          "faction": "enemy",
          "position": [
            0.39,
            0.88
          ],
          "label": "군체 오염 둥지 14",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-15",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.49,
            0.83
          ],
          "label": "군체 오염 둥지 15",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-16",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.59,
            0.89
          ],
          "label": "군체 오염 둥지 16",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-17",
          "building": "barracks",
          "faction": "enemy",
          "position": [
            0.68,
            0.82
          ],
          "label": "군체 오염 둥지 17",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-18",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.75,
            0.76
          ],
          "label": "군체 오염 둥지 18",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-19",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.12,
            0.3
          ],
          "label": "군체 오염 둥지 19",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-20",
          "building": "barracks",
          "faction": "enemy",
          "position": [
            0.18,
            0.38
          ],
          "label": "군체 오염 둥지 20",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-21",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.11,
            0.47
          ],
          "label": "군체 오염 둥지 21",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-22",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.19,
            0.64
          ],
          "label": "군체 오염 둥지 22",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-23",
          "building": "barracks",
          "faction": "enemy",
          "position": [
            0.13,
            0.73
          ],
          "label": "군체 오염 둥지 23",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-24",
          "building": "supply",
          "faction": "enemy",
          "position": [
            0.22,
            0.78
          ],
          "label": "군체 오염 둥지 24",
          "objectiveGroup": "infestation"
        },
        {
          "id": "infest-guard-1",
          "building": "thornTower",
          "faction": "enemy",
          "position": [
            0.43,
            0.12
          ],
          "label": "군체 방어 가시"
        },
        {
          "id": "infest-guard-2",
          "building": "thornTower",
          "faction": "enemy",
          "position": [
            0.85,
            0.5
          ],
          "label": "군체 방어 가시"
        },
        {
          "id": "infest-guard-3",
          "building": "thornTower",
          "faction": "enemy",
          "position": [
            0.5,
            0.87
          ],
          "label": "군체 방어 가시"
        },
        {
          "id": "infest-guard-4",
          "building": "thornTower",
          "faction": "enemy",
          "position": [
            0.14,
            0.5
          ],
          "label": "군체 방어 가시"
        }
      ],
      "attackForces": [
        {
          "id": "night-basic-north",
          "faction": "enemy",
          "position": [
            0.5,
            0.05
          ],
          "composition": [
            {
              "unit": "swarmbug",
              "count": 8
            }
          ],
          "formation": "spread",
          "spawnOnStart": false,
          "label": "north 야간 군락"
        },
        {
          "id": "night-ranged-north",
          "faction": "enemy",
          "position": [
            0.5,
            0.05
          ],
          "composition": [
            {
              "unit": "swarmbug",
              "count": 6
            },
            {
              "unit": "rootstalker",
              "count": 2
            }
          ],
          "formation": "spread",
          "spawnOnStart": false,
          "label": "north 강화 군락"
        },
        {
          "id": "night-heavy-north",
          "faction": "enemy",
          "position": [
            0.5,
            0.05
          ],
          "composition": [
            {
              "unit": "swarmbug",
              "count": 10
            },
            {
              "unit": "shelltitan",
              "count": 1
            }
          ],
          "formation": "spread",
          "spawnOnStart": false,
          "label": "north 중군락"
        },
        {
          "id": "night-basic-east",
          "faction": "enemy",
          "position": [
            0.96,
            0.52
          ],
          "composition": [
            {
              "unit": "swarmbug",
              "count": 8
            }
          ],
          "formation": "spread",
          "spawnOnStart": false,
          "label": "east 야간 군락"
        },
        {
          "id": "night-ranged-east",
          "faction": "enemy",
          "position": [
            0.96,
            0.52
          ],
          "composition": [
            {
              "unit": "swarmbug",
              "count": 6
            },
            {
              "unit": "rootstalker",
              "count": 2
            }
          ],
          "formation": "spread",
          "spawnOnStart": false,
          "label": "east 강화 군락"
        },
        {
          "id": "night-heavy-east",
          "faction": "enemy",
          "position": [
            0.96,
            0.52
          ],
          "composition": [
            {
              "unit": "swarmbug",
              "count": 10
            },
            {
              "unit": "shelltitan",
              "count": 1
            }
          ],
          "formation": "spread",
          "spawnOnStart": false,
          "label": "east 중군락"
        },
        {
          "id": "night-basic-southwest",
          "faction": "enemy",
          "position": [
            0.05,
            0.9
          ],
          "composition": [
            {
              "unit": "swarmbug",
              "count": 8
            }
          ],
          "formation": "spread",
          "spawnOnStart": false,
          "label": "southwest 야간 군락"
        },
        {
          "id": "night-ranged-southwest",
          "faction": "enemy",
          "position": [
            0.05,
            0.9
          ],
          "composition": [
            {
              "unit": "swarmbug",
              "count": 6
            },
            {
              "unit": "rootstalker",
              "count": 2
            }
          ],
          "formation": "spread",
          "spawnOnStart": false,
          "label": "southwest 강화 군락"
        },
        {
          "id": "night-heavy-southwest",
          "faction": "enemy",
          "position": [
            0.05,
            0.9
          ],
          "composition": [
            {
              "unit": "swarmbug",
              "count": 10
            },
            {
              "unit": "shelltitan",
              "count": 1
            }
          ],
          "formation": "spread",
          "spawnOnStart": false,
          "label": "southwest 중군락"
        }
      ]
    },
    "events": [
      {
        "id": "night-warning",
        "when": {
          "type": "cyclePhase",
          "cycleSeconds": 420,
          "startSeconds": 150,
          "endSeconds": 155
        },
        "actions": [
          {
            "type": "toast",
            "text": "해가 저문다. 외곽 병력을 회수하고 기지 방어를 준비해."
          }
        ],
        "once": false,
        "cooldownMs": 410000
      },
      {
        "id": "night-start",
        "when": {
          "type": "cyclePhase",
          "cycleSeconds": 420,
          "startSeconds": 180,
          "endSeconds": 185
        },
        "actions": [
          {
            "type": "setFlag",
            "id": "night",
            "value": true
          },
          {
            "type": "toast",
            "text": "위험기 시작. 군체가 세 방향에서 움직이기 시작했다."
          },
          {
            "type": "setObjective",
            "id": "survive",
            "text": "위험기 동안 기지를 방어하라",
            "state": "active"
          }
        ],
        "once": false,
        "cooldownMs": 410000
      },
      {
        "id": "day-start",
        "when": {
          "type": "cyclePhase",
          "cycleSeconds": 420,
          "startSeconds": 0,
          "endSeconds": 5,
          "cycleAtLeast": 2
        },
        "actions": [
          {
            "type": "setFlag",
            "id": "night",
            "value": false
          },
          {
            "type": "toast",
            "text": "안전기다. 지금 외곽 둥지를 제거하고 전선을 넓혀."
          },
          {
            "type": "completeObjective",
            "id": "survive"
          }
        ],
        "once": false,
        "cooldownMs": 410000
      },
      {
        "id": "wave-basic-north",
        "when": {
          "type": "cyclePhase",
          "cycleSeconds": 420,
          "startSeconds": 180,
          "endSeconds": 420
        },
        "actions": [
          {
            "type": "attackWave",
            "objectId": "night-basic-north",
            "target": "playerBase"
          }
        ],
        "once": false,
        "cooldownMs": 35000
      },
      {
        "id": "wave-ranged-north",
        "when": {
          "type": "cyclePhase",
          "cycleSeconds": 420,
          "startSeconds": 180,
          "endSeconds": 420,
          "cycleAtLeast": 2
        },
        "actions": [
          {
            "type": "attackWave",
            "objectId": "night-ranged-north",
            "target": "playerBase"
          }
        ],
        "once": false,
        "cooldownMs": 55000
      },
      {
        "id": "wave-heavy-north",
        "when": {
          "type": "cyclePhase",
          "cycleSeconds": 420,
          "startSeconds": 180,
          "endSeconds": 420,
          "cycleAtLeast": 3
        },
        "actions": [
          {
            "type": "attackWave",
            "objectId": "night-heavy-north",
            "target": "playerBase"
          }
        ],
        "once": false,
        "cooldownMs": 75000
      },
      {
        "id": "wave-basic-east",
        "when": {
          "type": "cyclePhase",
          "cycleSeconds": 420,
          "startSeconds": 180,
          "endSeconds": 420
        },
        "actions": [
          {
            "type": "attackWave",
            "objectId": "night-basic-east",
            "target": "playerBase"
          }
        ],
        "once": false,
        "cooldownMs": 35000
      },
      {
        "id": "wave-ranged-east",
        "when": {
          "type": "cyclePhase",
          "cycleSeconds": 420,
          "startSeconds": 180,
          "endSeconds": 420,
          "cycleAtLeast": 2
        },
        "actions": [
          {
            "type": "attackWave",
            "objectId": "night-ranged-east",
            "target": "playerBase"
          }
        ],
        "once": false,
        "cooldownMs": 55000
      },
      {
        "id": "wave-heavy-east",
        "when": {
          "type": "cyclePhase",
          "cycleSeconds": 420,
          "startSeconds": 180,
          "endSeconds": 420,
          "cycleAtLeast": 3
        },
        "actions": [
          {
            "type": "attackWave",
            "objectId": "night-heavy-east",
            "target": "playerBase"
          }
        ],
        "once": false,
        "cooldownMs": 75000
      },
      {
        "id": "wave-basic-southwest",
        "when": {
          "type": "cyclePhase",
          "cycleSeconds": 420,
          "startSeconds": 180,
          "endSeconds": 420
        },
        "actions": [
          {
            "type": "attackWave",
            "objectId": "night-basic-southwest",
            "target": "playerBase"
          }
        ],
        "once": false,
        "cooldownMs": 35000
      },
      {
        "id": "wave-ranged-southwest",
        "when": {
          "type": "cyclePhase",
          "cycleSeconds": 420,
          "startSeconds": 180,
          "endSeconds": 420,
          "cycleAtLeast": 2
        },
        "actions": [
          {
            "type": "attackWave",
            "objectId": "night-ranged-southwest",
            "target": "playerBase"
          }
        ],
        "once": false,
        "cooldownMs": 55000
      },
      {
        "id": "wave-heavy-southwest",
        "when": {
          "type": "cyclePhase",
          "cycleSeconds": 420,
          "startSeconds": 180,
          "endSeconds": 420,
          "cycleAtLeast": 3
        },
        "actions": [
          {
            "type": "attackWave",
            "objectId": "night-heavy-southwest",
            "target": "playerBase"
          }
        ],
        "once": false,
        "cooldownMs": 75000
      },
      {
        "id": "remain-12",
        "when": {
          "type": "structureCount",
          "side": "enemy",
          "group": "infestation",
          "op": "<=",
          "value": 12
        },
        "actions": [
          {
            "type": "toast",
            "text": "절반을 정리했다. 남은 군체 둥지를 계속 밀어내."
          },
          {
            "type": "setObjective",
            "id": "cleanse",
            "text": "군체 오염 둥지를 파괴하라 · 12개 이하 남음",
            "state": "active"
          }
        ]
      },
      {
        "id": "remain-5",
        "when": {
          "type": "structureCount",
          "side": "enemy",
          "group": "infestation",
          "op": "<=",
          "value": 5
        },
        "actions": [
          {
            "type": "toast",
            "text": "거의 끝났다. 남은 둥지 위치를 정리해."
          },
          {
            "type": "setObjective",
            "id": "cleanse",
            "text": "군체 오염 둥지를 파괴하라 · 5개 이하 남음",
            "state": "active"
          }
        ]
      },
      {
        "id": "victory",
        "when": {
          "type": "structureCount",
          "side": "enemy",
          "group": "infestation",
          "op": "=",
          "value": 0
        },
        "actions": [
          {
            "type": "completeObjective",
            "id": "cleanse"
          },
          {
            "type": "toast",
            "text": "마지막 둥지가 무너졌다. 이 구역의 군체 활동이 멎고 있어."
          },
          {
            "type": "victory"
          }
        ],
        "delayMs": 1200
      }
    ],
    "version": 2,
    script: {
      onInit(ctx) { ctx.state.lastPhase = null; },
      onStart(ctx) { ctx.emit("campaignScriptStarted", { missionId: ctx.mission.missionId }); },
      onTick(ctx) {
        const cycle = 240;
        const phase = (ctx.time.seconds % cycle) >= 180 ? "night" : "day";
        if (phase !== ctx.state.lastPhase) {
          ctx.state.lastPhase = phase;
          ctx.emit("campaignPhaseChanged", { phase, cycle: Math.floor(ctx.time.seconds / cycle) + 1 });
        }
      },
      onEvent(ctx, event) {},
      onDispose(ctx) {}
    }
  };
  return mission;
})()
