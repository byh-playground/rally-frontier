// RALLY FRONTIER Campaign Mission · migrated from flower-01 v18
(()=>{
  const mission = {
  "schemaVersion": 6,
  "missionId": "flower-01",
  "title": "화원 01 · 낯선 개척자",
  "briefing": "평온하던 화원 외곽의 채집지가 끊겼다. 넓은 국경 지대를 수색하고, 침입한 군체의 전진 병력을 막은 뒤 강 너머 개척 거점을 몰아내라.",
  "faction": "flower",
  "seed": 41001,
  "player": {
    "techCap": 1,
    "units": [
      "swordsman",
      "archer",
      "dandelion"
    ],
    "defenseCards": [
      "thornTowerCard"
    ]
  },
  "enemy": {
    "techCap": 1,
    "difficulty": "normal",
    "units": [
      "shellbug",
      "stingbug",
      "skirmisher"
    ],
    "defenseCards": [
      "thornTowerCard"
    ]
  },
  "map": {
    "biome": "flower-border",
    "spawns": {
      "host": [
        0.12,
        0.82
      ],
      "guest": [
        0.88,
        0.14
      ]
    },
    "lanes": {
      "top": [
        [
          0.12,
          0.82
        ],
        [
          0.16,
          0.62
        ],
        [
          0.12,
          0.43
        ],
        [
          0.26,
          0.28
        ],
        [
          0.48,
          0.2
        ],
        [
          0.7,
          0.18
        ],
        [
          0.88,
          0.14
        ]
      ],
      "mid": [
        [
          0.12,
          0.82
        ],
        [
          0.3,
          0.74
        ],
        [
          0.46,
          0.62
        ],
        [
          0.53,
          0.49
        ],
        [
          0.62,
          0.38
        ],
        [
          0.77,
          0.27
        ],
        [
          0.88,
          0.14
        ]
      ],
      "bot": [
        [
          0.12,
          0.82
        ],
        [
          0.34,
          0.88
        ],
        [
          0.57,
          0.82
        ],
        [
          0.76,
          0.7
        ],
        [
          0.88,
          0.52
        ],
        [
          0.91,
          0.31
        ],
        [
          0.88,
          0.14
        ]
      ]
    },
    "terrain": {
      "river": {
        "halfWidth": 0.034,
        "points": [
          [
            0.03,
            0.36
          ],
          [
            0.18,
            0.4
          ],
          [
            0.34,
            0.44
          ],
          [
            0.49,
            0.48
          ],
          [
            0.63,
            0.52
          ],
          [
            0.78,
            0.58
          ],
          [
            0.97,
            0.63
          ]
        ]
      },
      "bridges": [
        {
          "id": "west-ford",
          "position": [
            0.25,
            0.42
          ],
          "angle": -0.55,
          "halfLength": 0.058,
          "halfWidth": 0.019
        },
        {
          "id": "border-mid-bridge",
          "position": [
            0.52,
            0.49
          ],
          "angle": -0.72,
          "halfLength": 0.07,
          "halfWidth": 0.023
        },
        {
          "id": "east-ford",
          "position": [
            0.79,
            0.58
          ],
          "angle": -0.62,
          "halfLength": 0.055,
          "halfWidth": 0.018
        }
      ],
      "hills": [
        {
          "id": "north-watch-hill",
          "center": [
            0.31,
            0.27
          ],
          "rx": 0.085,
          "ry": 0.055,
          "angle": 0.2
        },
        {
          "id": "central-flower-rise",
          "center": [
            0.4,
            0.69
          ],
          "rx": 0.075,
          "ry": 0.05,
          "angle": -0.35
        },
        {
          "id": "east-ridge",
          "center": [
            0.72,
            0.39
          ],
          "rx": 0.09,
          "ry": 0.048,
          "angle": 0.45
        },
        {
          "id": "south-rise",
          "center": [
            0.72,
            0.76
          ],
          "rx": 0.075,
          "ry": 0.045,
          "angle": -0.2
        }
      ]
    },
    "capturePoints": [
      {
        "id": "flower-border-resource",
        "position": [
          0.35,
          0.72
        ],
        "lane": "mid",
        "label": "외곽 채집지",
        "stage": 1,
        "enabled": true
      },
      {
        "id": "west-bridgehead",
        "position": [
          0.25,
          0.42
        ],
        "lane": "top",
        "label": "서부 도하 거점",
        "stage": 1,
        "enabled": true
      },
      {
        "id": "mid-bridgehead",
        "position": [
          0.56,
          0.46
        ],
        "lane": "mid",
        "label": "중앙 교두보",
        "stage": 2,
        "enabled": true
      },
      {
        "id": "east-expansion",
        "position": [
          0.78,
          0.67
        ],
        "lane": "bot",
        "label": "동부 확장지",
        "stage": 1,
        "enabled": true
      },
      {
        "id": "swarm-forward-yard",
        "position": [
          0.76,
          0.28
        ],
        "lane": "top",
        "label": "군체 전진 개척지",
        "stage": 2,
        "enabled": true
      }
    ],
    "type": "manual",
    "content": {
      "resourcePlacement": "objective-auto",
      "resourceAmounts": {
        "baseMineral": 350,
        "baseGas": 800,
        "objectiveMineral": 900,
        "objectiveGas": 1800
      }
    },
    "garrisons": [
      {
        "id": "swarm-resource-scouts",
        "label": "군체 채집 정찰대",
        "spread": 0.025,
        "faction": "enemy",
        "formation": "spread",
        "composition": [
          {
            "unit": "shellbug",
            "count": 4
          },
          {
            "unit": "stingbug",
            "count": 2
          },
          {
            "unit": "skirmisher",
            "count": 1
          }
        ],
        "guardRadius": 0.075,
        "spawnOnStart": true,
        "capturePoint": "flower-border-resource",
        "offset": [
          0.02,
          -0.015
        ]
      },
      {
        "id": "swarm-west-raiders",
        "label": "군체 서부 우회대",
        "spread": 0.03,
        "faction": "enemy",
        "formation": "cluster",
        "composition": [
          {
            "unit": "shellbug",
            "count": 4
          },
          {
            "unit": "stingbug",
            "count": 2
          },
          {
            "unit": "skirmisher",
            "count": 1
          }
        ],
        "guardRadius": 0.08,
        "spawnOnStart": true,
        "capturePoint": "west-bridgehead",
        "offset": [
          0.015,
          -0.015
        ]
      },
      {
        "id": "swarm-bridge-guard",
        "label": "군체 중앙 방어선",
        "spread": 0.04,
        "faction": "enemy",
        "formation": "line",
        "composition": [
          {
            "unit": "shellbug",
            "count": 8
          },
          {
            "unit": "stingbug",
            "count": 4
          },
          {
            "unit": "skirmisher",
            "count": 2
          }
        ],
        "guardRadius": 0.075,
        "spawnOnStart": true,
        "capturePoint": "mid-bridgehead",
        "offset": [
          0.025,
          -0.015
        ]
      },
      {
        "id": "swarm-forward-guard",
        "label": "군체 개척지 경비대",
        "spread": 0.045,
        "faction": "enemy",
        "formation": "line",
        "composition": [
          {
            "unit": "shellbug",
            "count": 10
          },
          {
            "unit": "stingbug",
            "count": 4
          },
          {
            "unit": "skirmisher",
            "count": 2
          }
        ],
        "guardRadius": 0.085,
        "spawnOnStart": true,
        "capturePoint": "swarm-forward-yard",
        "offset": [
          0,
          0
        ]
      }
    ],
    "attackForces": [
      {
        "id": "swarm-opening-rush",
        "label": "군체 선발대",
        "position": [
          0.62,
          0.38
        ],
        "spread": 0.035,
        "spawnOnStart": false,
        "faction": "enemy",
        "formation": "cluster",
        "composition": [
          {
            "unit": "shellbug",
            "count": 7
          },
          {
            "unit": "stingbug",
            "count": 3
          },
          {
            "unit": "skirmisher",
            "count": 2
          }
        ],
        "guardRadius": 0.08
      },
      {
        "id": "swarm-final-reserve",
        "label": "군체 개척지 예비대",
        "position": [
          0.84,
          0.2
        ],
        "spread": 0.04,
        "spawnOnStart": false,
        "faction": "enemy",
        "formation": "cluster",
        "composition": [
          {
            "unit": "shellbug",
            "count": 8
          },
          {
            "unit": "stingbug",
            "count": 3
          },
          {
            "unit": "skirmisher",
            "count": 1
          }
        ],
        "guardRadius": 0.08
      }
    ],
    "structures": [
      {
        "id": "def-border-1",
        "building": "thornTower",
        "faction": "enemy",
        "capturePoint": "flower-border-resource",
        "offset": [
          0.03,
          -0.02
        ],
        "label": "외곽 가시꽃 초소"
      },
      {
        "id": "def-west-1",
        "building": "thornTower",
        "faction": "enemy",
        "capturePoint": "west-bridgehead",
        "offset": [
          0.028,
          -0.025
        ],
        "label": "서부 가시꽃 초소"
      },
      {
        "id": "def-mid-1",
        "building": "thornTower",
        "faction": "enemy",
        "capturePoint": "mid-bridgehead",
        "offset": [
          0.03,
          -0.022
        ],
        "label": "중앙 가시꽃 초소"
      },
      {
        "id": "def-mid-2",
        "building": "thornTower",
        "faction": "enemy",
        "capturePoint": "mid-bridgehead",
        "offset": [
          -0.025,
          -0.028
        ],
        "label": "중앙 가시꽃 초소"
      },
      {
        "id": "def-forward-1",
        "building": "thornTower",
        "faction": "enemy",
        "capturePoint": "swarm-forward-yard",
        "offset": [
          0.035,
          0
        ],
        "label": "개척지 가시꽃 초소"
      },
      {
        "id": "def-forward-2",
        "building": "thornTower",
        "faction": "enemy",
        "capturePoint": "swarm-forward-yard",
        "offset": [
          -0.03,
          0.025
        ],
        "label": "개척지 가시꽃 초소"
      }
    ]
  },
  "presentation": {
    "opening": [
      "외곽 채집지가 며칠째 응답하지 않고 있다.",
      "국경은 넓다. 병력을 나눠 외곽 채집지를 확인하라."
    ],
    "outro": [
      "정찰대: 군체가 물러난다. 개척 거점의 움직임도 멈췄어.",
      "지휘: 이 정도 병력이 우연히 국경을 넘은 건 아니다.",
      "정찰대: 북쪽에서 더 많은 흔적이 발견됐어. 같은 방향으로 이어져 있어.",
      "지휘: 본진에 알린다. 다음에는 우리가 먼저 움직인다."
    ]
  },
  "regions": {
    "outer-resource": {
      "center": [
        0.36,
        0.71
      ],
      "radius": 0.12
    },
    "west-ford": {
      "center": [
        0.25,
        0.42
      ],
      "radius": 0.08
    },
    "mid-bridge": {
      "center": [
        0.52,
        0.49
      ],
      "radius": 0.085
    },
    "bridgehead": {
      "center": [
        0.57,
        0.45
      ],
      "radius": 0.1
    },
    "east-route": {
      "center": [
        0.76,
        0.62
      ],
      "radius": 0.1
    },
    "swarm-yard": {
      "center": [
        0.76,
        0.28
      ],
      "radius": 0.15
    },
    "swarm-main": {
      "center": [
        0.87,
        0.16
      ],
      "radius": 0.13
    }
  },
  "flags": {
    "firstContact": false,
    "rushLaunched": false,
    "rushDefeated": false,
    "bridgeheadTaken": false,
    "yardRevealed": false
  },
  "objectives": [
    {
      "id": "inspect-border",
      "text": "외곽 채집지를 확보하고 주변을 수색하라",
      "state": "active"
    },
    {
      "id": "hold-rush",
      "text": "군체 선발대의 첫 공격을 막아라",
      "state": "hidden"
    },
    {
      "id": "take-bridgehead",
      "text": "중앙 교두보를 확보하라",
      "state": "hidden"
    },
    {
      "id": "break-yard",
      "text": "군체 개척 거점을 파괴하라",
      "state": "hidden"
    }
  ],
  "version": 18,
  "events": [
    {
      "id": "resource-contact",
      "when": {
        "type": "discoverObject",
        "objectId": "swarm-resource-scouts",
        "radius": 0.12
      },
      "actions": [
        {
          "type": "setFlag",
          "id": "firstContact",
          "value": true
        },
        {
          "type": "completeObjective",
          "id": "inspect-border"
        },
        {
          "type": "setObjective",
          "id": "hold-rush",
          "text": "군체 선발대의 공격을 막아라",
          "state": "active"
        },
        {
          "type": "toast",
          "text": "정찰대: 멈춰. 처음 보는 군락이다. 우리 채집지까지 들어와 있다."
        }
      ]
    },
    {
      "id": "opening-rush",
      "when": {
        "all": [
          {
            "type": "flag",
            "id": "firstContact",
            "equals": true
          },
          {
            "type": "time",
            "seconds": 90
          }
        ]
      },
      "actions": [
        {
          "type": "setFlag",
          "id": "rushLaunched",
          "value": true
        },
        {
          "type": "toast",
          "text": "정찰대: 중앙 북쪽에서 대규모 병력이 움직인다. 본진으로 온다!",
          "durationMs": 4200
        },
        {
          "type": "spawnObject",
          "objectId": "swarm-opening-rush"
        },
        {
          "type": "order",
          "group": "swarm-opening-rush",
          "order": "attack",
          "target": "playerBase"
        },
        {
          "type": "order",
          "group": "swarm-west-raiders",
          "order": "attack",
          "target": "playerBase"
        }
      ]
    },
    {
      "id": "rush-cleared",
      "when": {
        "all": [
          {
            "type": "flag",
            "id": "rushLaunched",
            "equals": true
          },
          {
            "type": "objectDead",
            "objectId": "swarm-opening-rush"
          },
          {
            "type": "objectDead",
            "objectId": "swarm-west-raiders"
          }
        ]
      },
      "actions": [
        {
          "type": "setFlag",
          "id": "rushDefeated",
          "value": true
        },
        {
          "type": "completeObjective",
          "id": "hold-rush"
        },
        {
          "type": "setObjective",
          "id": "take-bridgehead",
          "text": "중앙 교두보를 확보하라",
          "state": "active"
        },
        {
          "type": "toast",
          "text": "지휘: 선발대를 막았다. 이제 중앙을 되찾고 강 건너로 밀어낸다."
        }
      ]
    },
    {
      "id": "west-route-hint",
      "when": {
        "all": [
          {
            "type": "flag",
            "id": "rushDefeated",
            "equals": true
          },
          {
            "type": "unitsInRegion",
            "region": "west-ford",
            "count": 1
          }
        ]
      },
      "actions": [
        {
          "type": "toast",
          "text": "정찰대: 서쪽 얕은 길도 건널 수 있다. 중앙 방어선을 우회할 수 있겠다."
        }
      ]
    },
    {
      "id": "east-route-hint",
      "when": {
        "all": [
          {
            "type": "flag",
            "id": "rushDefeated",
            "equals": true
          },
          {
            "type": "unitsInRegion",
            "region": "east-route",
            "count": 1
          }
        ]
      },
      "actions": [
        {
          "type": "toast",
          "text": "정찰대: 동쪽 길은 멀지만 자원이 많다. 장기전을 준비하기 좋다."
        }
      ]
    },
    {
      "id": "bridgehead-taken",
      "when": {
        "all": [
          {
            "type": "flag",
            "id": "rushDefeated",
            "equals": true
          },
          {
            "type": "regionCaptured",
            "id": "mid-bridgehead"
          }
        ]
      },
      "actions": [
        {
          "type": "setFlag",
          "id": "bridgeheadTaken",
          "value": true
        },
        {
          "type": "completeObjective",
          "id": "take-bridgehead"
        },
        {
          "type": "setObjective",
          "id": "break-yard",
          "text": "군체 개척 거점을 파괴하라",
          "state": "active"
        },
        {
          "type": "cameraFocus",
          "region": "swarm-yard"
        },
        {
          "type": "toast",
          "text": "정찰대: 잠깐… 저건 전초기지가 아니다. 이미 큰 개척지가 만들어져 있다."
        },
        {
          "type": "spawnObject",
          "objectId": "swarm-final-reserve"
        }
      ]
    },
    {
      "id": "yard-contact",
      "when": {
        "all": [
          {
            "type": "flag",
            "id": "bridgeheadTaken",
            "equals": true
          },
          {
            "type": "discoverObject",
            "objectId": "swarm-forward-guard",
            "radius": 0.15
          }
        ]
      },
      "actions": [
        {
          "type": "setFlag",
          "id": "yardRevealed",
          "value": true
        },
        {
          "type": "toast",
          "text": "지휘: 개척지의 생산 병력까지 합류한다. 여기서 밀어내지 못하면 국경 전체가 위험하다."
        }
      ]
    },
    {
      "id": "yard-cleared",
      "when": {
        "all": [
          {
            "type": "flag",
            "id": "bridgeheadTaken",
            "equals": true
          },
          {
            "type": "objectDead",
            "objectId": "swarm-forward-guard"
          },
          {
            "type": "objectDead",
            "objectId": "swarm-final-reserve"
          }
        ]
      },
      "actions": [
        {
          "type": "completeObjective",
          "id": "break-yard"
        },
        {
          "type": "toast",
          "text": "정찰대: 개척지 방어선이 무너졌다. 남은 건 군체의 주 거점뿐이다."
        }
      ]
    }
  ],
  script: {
    onInit(ctx) { ctx.state.startedAtTick = ctx.time.tick; },
    onStart(ctx) { ctx.emit("campaignScriptStarted", { missionId: ctx.mission.missionId }); },
    onTick(ctx) {},
    onEvent(ctx, event) {},
    onDispose(ctx) {}
  }
};
  return mission;
})()
