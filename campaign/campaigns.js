// Authored campaign data. Terrain and mission execution use the shared engine in index.html.
export default {
 schemaVersion: 2,
 campaigns: [
  {
    "id": "frontier-opening",
    "title": "개척 전선",
    "missions": [
      {
        "id": "frontier-01-first-flag",
        "title": "1. 첫 깃발",
        "mission": {
          "schemaVersion": 7,
          "missionId": "frontier-01-first-flag",
          "title": "1. 첫 깃발",
          "briefing": "넓은 개척로를 따라 고립된 칼잎 전사대와 합류하고 첫 전선을 만드십시오. 적도 같은 해금 병종과 테크 안에서 채집·건설·생산합니다. 생산시설을 세워 전선을 유지하십시오. 적은 병력을 모아 반복 공격합니다.",
          "playerRole": "host",
          "faction": "frontier",
          "seed": 690101,
          "victory": {
            "type": "scripted"
          },
          "player": {
            "availableUnits": [],
            "startingUnits": [
              {
                "unit": "swordsman",
                "count": 3
              }
            ],
            "startingWorkers": 5,
            "startingResources": {
              "minerals": 325,
              "gas": 0
            },
            "startingTech": 1,
            "startingBuildings": [
              {
                "id": "opening-supply-1",
                "building": "supply"
              },
              {
                "id": "opening-supply-2",
                "building": "supply"
              }
            ],
            "defenseCards": [],
            "techCap": 1
          },
          "enemy": {
            "availableUnits": [],
            "startingUnits": [
              {
                "unit": "swordsman",
                "count": 3
              }
            ],
            "startingWorkers": 5,
            "startingResources": {
              "minerals": 325,
              "gas": 0
            },
            "startingTech": 1,
            "startingBuildings": [],
            "defenseCards": [],
            "techCap": 1,
            "aiProfile": "standard",
            "offense": {
              "firstAttackMs": 60000,
              "regroupMs": 20000,
              "attackSize": 6,
              "counterattackPoints": [],
              "productionLimit": 1
            }
          },
          "map": {
            "type": "manual",
            "width": 3600,
            "height": 4200,
            "biome": "flower-border",
            "spawns": {
              "host": [
                0.14,
                0.84
              ],
              "guest": [
                0.86,
                0.16
              ]
            },
            "lanes": {
              "top": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.27,
                  0.74
                ],
                [
                  0.3,
                  0.69
                ],
                [
                  0.43,
                  0.58
                ],
                [
                  0.59,
                  0.43
                ],
                [
                  0.86,
                  0.16
                ]
              ],
              "mid": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.3,
                  0.69
                ],
                [
                  0.46,
                  0.56
                ],
                [
                  0.66,
                  0.35
                ],
                [
                  0.86,
                  0.16
                ]
              ],
              "bot": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.34,
                  0.76
                ],
                [
                  0.52,
                  0.63
                ],
                [
                  0.71,
                  0.38
                ],
                [
                  0.86,
                  0.16
                ]
              ]
            },
            "capturePoints": [],
            "terrain": {
              "river": {
                "points": [],
                "halfWidth": 0.03
              },
              "bridges": [],
              "layers": [],
              "ramps": [],
              "blockers": [
                {
                  "id": "west-root-border",
                  "kind": "roots",
                  "points": [
                    [
                      0.07,
                      0.49
                    ],
                    [
                      0.15,
                      0.5
                    ],
                    [
                      0.16,
                      0.59
                    ],
                    [
                      0.1,
                      0.62
                    ]
                  ],
                  "blocksMovement": true,
                  "blocksVision": true,
                  "blocksProjectile": false,
                  "blocksAirVision": false
                },
                {
                  "id": "south-root-border",
                  "kind": "roots",
                  "points": [
                    [
                      0.56,
                      0.78
                    ],
                    [
                      0.66,
                      0.78
                    ],
                    [
                      0.68,
                      0.86
                    ],
                    [
                      0.59,
                      0.88
                    ]
                  ],
                  "blocksMovement": true,
                  "blocksVision": true,
                  "blocksProjectile": false,
                  "blocksAirVision": false
                }
              ],
              "roads": [
                {
                  "id": "opening-road",
                  "points": [
                    [
                      0.14,
                      0.84
                    ],
                    [
                      0.27,
                      0.74
                    ],
                    [
                      0.3,
                      0.69
                    ],
                    [
                      0.43,
                      0.58
                    ],
                    [
                      0.59,
                      0.43
                    ],
                    [
                      0.73,
                      0.3
                    ],
                    [
                      0.86,
                      0.16
                    ]
                  ],
                  "width": 0.065
                }
              ]
            },
            "content": {
              "resourcePlacement": "objective-auto"
            },
            "garrisons": [
              {
                "id": "rescue-blades",
                "label": "고립된 칼잎 전사대",
                "position": [
                  0.3,
                  0.69
                ],
                "faction": "player",
                "composition": [
                  {
                    "unit": "swordsman",
                    "count": 5
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              },
              {
                "id": "rescue-raiders",
                "label": "포위 병력",
                "position": [
                  0.34,
                  0.65
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "shellbug",
                    "count": 2
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              }
            ],
            "attackForces": [],
            "structures": []
          },
          "regions": {
            "rescue": {
              "center": [
                0.3,
                0.69
              ],
              "radius": 0.1
            },
            "enemyBase": {
              "center": [
                0.86,
                0.16
              ],
              "radius": 0.12
            }
          },
          "objectives": [
            {
              "id": "rescue",
              "text": "개척로의 고립된 칼잎 전사대와 접촉하십시오.",
              "state": "active"
            },
            {
              "id": "breakthrough",
              "text": "합류한 병력과 생산 병력으로 적 본진을 파괴하십시오.",
              "state": "pending"
            }
          ],
          "flags": {},
          "events": [
            {
              "id": "rescue",
              "when": {
                "type": "enterRegion",
                "region": "rescue",
                "count": 1
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "rescue"
                },
                {
                  "type": "setFaction",
                  "group": "rescue-blades",
                  "faction": "player"
                },
                {
                  "type": "unlockUnit",
                  "unit": "swordsman"
                },
                {
                  "type": "unlockUnit",
                  "unit": "swordsman",
                  "side": "enemy"
                },
                {
                  "type": "toast",
                  "text": "칼잎 전사대가 합류했습니다. 이제 칼잎 전사를 생산할 수 있습니다."
                },
                {
                  "type": "setObjective",
                  "id": "breakthrough",
                  "text": "칼잎 전사를 생산하고 Rally로 전선을 밀어 적 본진을 파괴하십시오.",
                  "state": "active"
                },
                {
                  "type": "ping",
                  "region": "enemyBase"
                },
                {
                  "type": "setFlag",
                  "id": "lessonComplete",
                  "value": true
                }
              ]
            },
            {
              "id": "mission-victory",
              "when": {
                "all": [
                  {
                    "type": "flag",
                    "id": "lessonComplete",
                    "equals": true
                  },
                  {
                    "type": "structureCount",
                    "side": "enemy",
                    "types": [
                      "base"
                    ],
                    "op": "=",
                    "value": 0
                  }
                ]
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "breakthrough"
                },
                {
                  "type": "victory"
                }
              ]
            }
          ],
          "presentation": {
            "opening": [
              "개척지는 비어 있지 않았다.",
              "먼저 흩어진 전사들과 전선을 다시 잇는다."
            ],
            "outro": [
              "첫 전선이 연결되었다.",
              "깃발 하나가 병력을 움직이고, 생산 하나가 전선을 만든다."
            ]
          }
        }
      },
      {
        "id": "frontier-02-rear-fire",
        "title": "2. 뒤에서 쏘는 자들",
        "mission": {
          "schemaVersion": 7,
          "missionId": "frontier-02-rear-fire",
          "title": "2. 뒤에서 쏘는 자들",
          "briefing": "남쪽의 넓은 경사로로 궁수 고지에 올라 씨앗궁수대와 합류하십시오. 고지 북쪽에는 적 방어선이 있습니다. 적도 같은 해금 병종과 테크 안에서 채집·건설·생산합니다. 생산시설을 세워 전선을 유지하십시오. 적은 병력을 모아 반복 공격합니다.",
          "playerRole": "host",
          "faction": "frontier",
          "seed": 690102,
          "victory": {
            "type": "scripted"
          },
          "player": {
            "availableUnits": [
              "swordsman"
            ],
            "startingUnits": [
              {
                "unit": "swordsman",
                "count": 8
              }
            ],
            "startingWorkers": 5,
            "startingResources": {
              "minerals": 350,
              "gas": 0
            },
            "startingTech": 1,
            "startingBuildings": [
              {
                "id": "opening-supply-1",
                "building": "supply"
              },
              {
                "id": "opening-supply-2",
                "building": "supply"
              }
            ],
            "defenseCards": [],
            "techCap": 1
          },
          "enemy": {
            "availableUnits": [
              "swordsman"
            ],
            "startingUnits": [
              {
                "unit": "swordsman",
                "count": 8
              }
            ],
            "startingWorkers": 5,
            "startingResources": {
              "minerals": 350,
              "gas": 0
            },
            "startingTech": 1,
            "startingBuildings": [],
            "defenseCards": [],
            "techCap": 1,
            "aiProfile": "standard",
            "offense": {
              "firstAttackMs": 50000,
              "regroupMs": 20000,
              "attackSize": 8,
              "counterattackPoints": [],
              "productionLimit": 1
            }
          },
          "map": {
            "type": "manual",
            "width": 3600,
            "height": 4200,
            "biome": "flower-border",
            "spawns": {
              "host": [
                0.14,
                0.84
              ],
              "guest": [
                0.86,
                0.16
              ]
            },
            "lanes": {
              "top": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.26,
                  0.79
                ],
                [
                  0.37,
                  0.71
                ],
                [
                  0.37,
                  0.6
                ],
                [
                  0.37,
                  0.49
                ],
                [
                  0.62,
                  0.34
                ],
                [
                  0.86,
                  0.16
                ]
              ],
              "mid": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.37,
                  0.71
                ],
                [
                  0.37,
                  0.6
                ],
                [
                  0.37,
                  0.49
                ],
                [
                  0.57,
                  0.39
                ],
                [
                  0.86,
                  0.16
                ]
              ],
              "bot": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.55,
                  0.75
                ],
                [
                  0.57,
                  0.57
                ],
                [
                  0.62,
                  0.34
                ],
                [
                  0.86,
                  0.16
                ]
              ]
            },
            "capturePoints": [],
            "terrain": {
              "river": {
                "points": [],
                "halfWidth": 0.03
              },
              "bridges": [],
              "layers": [
                {
                  "id": "archer-high",
                  "level": 1,
                  "points": [
                    [
                      0.23,
                      0.475
                    ],
                    [
                      0.51,
                      0.475
                    ],
                    [
                      0.51,
                      0.725
                    ],
                    [
                      0.23,
                      0.725
                    ]
                  ]
                }
              ],
              "ramps": [
                {
                  "id": "archer-ramp",
                  "layerId": "archer-high",
                  "edge": 2,
                  "t0": 0.18,
                  "t1": 0.82,
                  "run": 0.025
                },
                {
                  "id": "archer-exit",
                  "layerId": "archer-high",
                  "edge": 0,
                  "t0": 0.18,
                  "t1": 0.82,
                  "run": 0.025
                }
              ],
              "blockers": [
                {
                  "id": "east-woodline",
                  "kind": "roots",
                  "points": [
                    [
                      0.63,
                      0.52
                    ],
                    [
                      0.71,
                      0.48
                    ],
                    [
                      0.76,
                      0.54
                    ],
                    [
                      0.7,
                      0.61
                    ]
                  ],
                  "blocksMovement": true,
                  "blocksVision": true,
                  "blocksProjectile": false,
                  "blocksAirVision": false
                }
              ],
              "roads": [
                {
                  "id": "archer-approach",
                  "points": [
                    [
                      0.14,
                      0.84
                    ],
                    [
                      0.26,
                      0.79
                    ],
                    [
                      0.37,
                      0.75
                    ],
                    [
                      0.37,
                      0.71
                    ],
                    [
                      0.37,
                      0.6
                    ],
                    [
                      0.37,
                      0.49
                    ],
                    [
                      0.37,
                      0.45
                    ],
                    [
                      0.62,
                      0.34
                    ],
                    [
                      0.86,
                      0.16
                    ]
                  ],
                  "width": 0.065
                }
              ]
            },
            "content": {
              "resourcePlacement": "objective-auto"
            },
            "garrisons": [
              {
                "id": "choke-guard",
                "label": "고지 북쪽 수비대",
                "position": [
                  0.47,
                  0.52
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "shellbug",
                    "count": 8
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              },
              {
                "id": "archer-rescue",
                "label": "고립된 씨앗궁수대",
                "position": [
                  0.37,
                  0.6
                ],
                "faction": "player",
                "composition": [
                  {
                    "unit": "archer",
                    "count": 6
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              },
              {
                "id": "archer-besiegers",
                "label": "궁수대를 포위한 적",
                "position": [
                  0.4,
                  0.57
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "swordsman",
                    "count": 4
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              }
            ],
            "attackForces": [],
            "structures": []
          },
          "regions": {
            "archers": {
              "center": [
                0.37,
                0.6
              ],
              "radius": 0.1
            },
            "choke": {
              "center": [
                0.47,
                0.52
              ],
              "radius": 0.1
            }
          },
          "objectives": [
            {
              "id": "reach",
              "text": "남쪽 경사로를 올라 고지의 씨앗궁수대와 접촉하십시오.",
              "state": "active"
            },
            {
              "id": "finish",
              "text": "전열과 후열을 조합해 적 본진을 파괴하십시오.",
              "state": "pending"
            }
          ],
          "flags": {},
          "events": [
            {
              "id": "join-archers",
              "when": {
                "type": "enterRegion",
                "region": "archers",
                "count": 1
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "reach"
                },
                {
                  "type": "setFaction",
                  "group": "archer-rescue",
                  "faction": "player"
                },
                {
                  "type": "unlockUnit",
                  "unit": "archer"
                },
                {
                  "type": "unlockUnit",
                  "unit": "archer",
                  "side": "enemy"
                },
                {
                  "type": "toast",
                  "text": "씨앗궁수대가 합류했습니다. 전열 뒤에서도 화력을 유지합니다."
                },
                {
                  "type": "setObjective",
                  "id": "finish",
                  "text": "칼잎 전사로 전선을 고정하고 씨앗궁수로 후방 화력을 더하십시오.",
                  "state": "active"
                },
                {
                  "type": "setFlag",
                  "id": "lessonComplete",
                  "value": true
                }
              ]
            },
            {
              "id": "mission-victory",
              "when": {
                "all": [
                  {
                    "type": "flag",
                    "id": "lessonComplete",
                    "equals": true
                  },
                  {
                    "type": "structureCount",
                    "side": "enemy",
                    "types": [
                      "base"
                    ],
                    "op": "=",
                    "value": 0
                  }
                ]
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "finish"
                },
                {
                  "type": "victory"
                }
              ]
            }
          ],
          "presentation": {
            "opening": [
              "적은 좁은 길을 막고 병력의 숫자를 무력화했다.",
              "싸울 자리를 늘릴 방법이 필요하다."
            ],
            "outro": [
              "앞에서 버티고 뒤에서 쏘는 전선이 완성되었다."
            ]
          }
        }
      },
      {
        "id": "frontier-03-spear-wall",
        "title": "3. 창벽",
        "mission": {
          "schemaVersion": 7,
          "missionId": "frontier-03-spear-wall",
          "title": "3. 창벽",
          "briefing": "양쪽 능선 사이의 넓은 협곡에서 가시창풀 방어선과 합류하십시오. 북쪽에서 빠른 돌격대가 후열을 노립니다. 적도 같은 해금 병종과 테크 안에서 채집·건설·생산합니다. 생산시설을 세워 전선을 유지하십시오. 적은 병력을 모아 반복 공격합니다.",
          "playerRole": "host",
          "faction": "frontier",
          "seed": 690103,
          "victory": {
            "type": "scripted"
          },
          "player": {
            "availableUnits": [
              "swordsman",
              "archer"
            ],
            "startingUnits": [
              {
                "unit": "swordsman",
                "count": 6
              },
              {
                "unit": "archer",
                "count": 5
              }
            ],
            "startingWorkers": 5,
            "startingResources": {
              "minerals": 400,
              "gas": 50
            },
            "startingTech": 1,
            "startingBuildings": [
              {
                "id": "opening-supply-1",
                "building": "supply"
              },
              {
                "id": "opening-supply-2",
                "building": "supply"
              },
              {
                "id": "opening-supply-3",
                "building": "supply"
              }
            ],
            "defenseCards": [],
            "techCap": 1
          },
          "enemy": {
            "availableUnits": [
              "swordsman",
              "archer"
            ],
            "startingUnits": [
              {
                "unit": "swordsman",
                "count": 8
              },
              {
                "unit": "archer",
                "count": 7
              }
            ],
            "startingWorkers": 5,
            "startingResources": {
              "minerals": 400,
              "gas": 50
            },
            "startingTech": 1,
            "startingBuildings": [],
            "defenseCards": [],
            "techCap": 1,
            "aiProfile": "standard",
            "offense": {
              "firstAttackMs": 45000,
              "regroupMs": 20000,
              "attackSize": 10,
              "counterattackPoints": [],
              "productionLimit": 2
            }
          },
          "map": {
            "type": "manual",
            "width": 3600,
            "height": 4200,
            "biome": "flower-border",
            "spawns": {
              "host": [
                0.14,
                0.84
              ],
              "guest": [
                0.86,
                0.16
              ]
            },
            "lanes": {
              "top": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.29,
                  0.73
                ],
                [
                  0.42,
                  0.58
                ],
                [
                  0.47,
                  0.54
                ],
                [
                  0.56,
                  0.46
                ],
                [
                  0.62,
                  0.39
                ],
                [
                  0.69,
                  0.29
                ],
                [
                  0.86,
                  0.16
                ]
              ],
              "mid": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.42,
                  0.58
                ],
                [
                  0.47,
                  0.54
                ],
                [
                  0.62,
                  0.39
                ],
                [
                  0.69,
                  0.29
                ],
                [
                  0.86,
                  0.16
                ]
              ],
              "bot": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.43,
                  0.73
                ],
                [
                  0.52,
                  0.6
                ],
                [
                  0.59,
                  0.51
                ],
                [
                  0.62,
                  0.39
                ],
                [
                  0.69,
                  0.29
                ],
                [
                  0.86,
                  0.16
                ]
              ]
            },
            "capturePoints": [],
            "terrain": {
              "river": {
                "points": [],
                "halfWidth": 0.03
              },
              "bridges": [],
              "layers": [
                {
                  "id": "valley-west-ridge",
                  "level": 1,
                  "points": [
                    [
                      0.16,
                      0.32
                    ],
                    [
                      0.37,
                      0.18
                    ],
                    [
                      0.61,
                      0.19
                    ],
                    [
                      0.43,
                      0.43
                    ],
                    [
                      0.24,
                      0.47
                    ]
                  ]
                },
                {
                  "id": "valley-east-ridge",
                  "level": 1,
                  "points": [
                    [
                      0.66,
                      0.45
                    ],
                    [
                      0.81,
                      0.33
                    ],
                    [
                      0.91,
                      0.43
                    ],
                    [
                      0.74,
                      0.66
                    ],
                    [
                      0.58,
                      0.73
                    ]
                  ]
                }
              ],
              "ramps": [
                {
                  "id": "west-ridge-ramp",
                  "layerId": "valley-west-ridge",
                  "edge": 4,
                  "t0": 0.2,
                  "t1": 0.7,
                  "run": 0.025
                },
                {
                  "id": "east-ridge-ramp",
                  "layerId": "valley-east-ridge",
                  "edge": 2,
                  "t0": 0.2,
                  "t1": 0.7,
                  "run": 0.025
                }
              ],
              "blockers": [],
              "roads": [
                {
                  "id": "spear-valley-road",
                  "points": [
                    [
                      0.14,
                      0.84
                    ],
                    [
                      0.29,
                      0.73
                    ],
                    [
                      0.42,
                      0.58
                    ],
                    [
                      0.47,
                      0.54
                    ],
                    [
                      0.56,
                      0.46
                    ],
                    [
                      0.62,
                      0.39
                    ],
                    [
                      0.69,
                      0.29
                    ],
                    [
                      0.86,
                      0.16
                    ]
                  ],
                  "width": 0.065
                }
              ]
            },
            "content": {
              "resourcePlacement": "objective-auto"
            },
            "garrisons": [
              {
                "id": "pike-rescue",
                "label": "협곡의 가시창풀",
                "position": [
                  0.42,
                  0.58
                ],
                "faction": "player",
                "composition": [
                  {
                    "unit": "pikeman",
                    "count": 6
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              },
              {
                "id": "pike-pressure",
                "label": "돌격 떼",
                "position": [
                  0.47,
                  0.54
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "dandelion",
                    "count": 10
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              }
            ],
            "attackForces": [
              {
                "id": "fast-wave",
                "label": "후열 돌파대",
                "position": [
                  0.62,
                  0.39
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "dandelion",
                    "count": 12
                  }
                ],
                "formation": "cluster",
                "spawnOnStart": false
              }
            ],
            "structures": []
          },
          "regions": {
            "pikes": {
              "center": [
                0.42,
                0.58
              ],
              "radius": 0.11
            }
          },
          "objectives": [
            {
              "id": "join",
              "text": "협곡 남쪽의 가시창풀 부대와 접촉하십시오.",
              "state": "active"
            },
            {
              "id": "hold",
              "text": "접근 차단 병종을 섞어 후열을 보호하십시오.",
              "state": "pending"
            }
          ],
          "flags": {},
          "events": [
            {
              "id": "join-pikes",
              "when": {
                "type": "enterRegion",
                "region": "pikes",
                "count": 1
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "join"
                },
                {
                  "type": "setFaction",
                  "group": "pike-rescue",
                  "faction": "player"
                },
                {
                  "type": "unlockUnit",
                  "unit": "pikeman"
                },
                {
                  "type": "unlockUnit",
                  "unit": "pikeman",
                  "side": "enemy"
                },
                {
                  "type": "toast",
                  "text": "가시창풀이 합류했습니다. 공격할 때마다 접근하는 적을 밀어냅니다."
                },
                {
                  "type": "setObjective",
                  "id": "hold",
                  "text": "가시창풀을 생산해 씨앗궁수에게 접근하는 적을 막으십시오.",
                  "state": "active"
                },
                {
                  "type": "spawnObject",
                  "objectId": "fast-wave"
                },
                {
                  "type": "order",
                  "group": "fast-wave",
                  "order": "attack",
                  "target": "playerBase"
                },
                {
                  "type": "setFlag",
                  "id": "lessonComplete",
                  "value": true
                }
              ]
            },
            {
              "id": "mission-victory",
              "when": {
                "all": [
                  {
                    "type": "flag",
                    "id": "lessonComplete",
                    "equals": true
                  },
                  {
                    "type": "structureCount",
                    "side": "enemy",
                    "types": [
                      "base"
                    ],
                    "op": "=",
                    "value": 0
                  }
                ]
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "hold"
                },
                {
                  "type": "victory"
                }
              ]
            }
          ],
          "presentation": {
            "opening": [
              "빠른 적은 전선을 우회하지 않는다. 전선을 밀어젖힌다.",
              "후열 앞에 창벽을 세운다."
            ],
            "outro": [
              "접근을 끊으면 후열의 시간이 늘어난다."
            ]
          }
        }
      },
      {
        "id": "frontier-04-moving-front",
        "title": "4. 움직이는 전선",
        "mission": {
          "schemaVersion": 7,
          "missionId": "frontier-04-moving-front",
          "title": "4. 움직이는 전선",
          "briefing": "남쪽 강변의 포자사수와 합류하십시오. 낮은 강바닥을 가로지르는 다리 북쪽에는 중장갑 병력과 넓은 기동장이 있습니다. 적도 같은 해금 병종과 테크 안에서 채집·건설·생산합니다. 생산시설을 세워 전선을 유지하십시오. 적은 병력을 모아 반복 공격합니다.",
          "playerRole": "host",
          "faction": "frontier",
          "seed": 690104,
          "victory": {
            "type": "scripted"
          },
          "player": {
            "availableUnits": [
              "swordsman",
              "archer",
              "pikeman"
            ],
            "startingUnits": [
              {
                "unit": "swordsman",
                "count": 5
              },
              {
                "unit": "pikeman",
                "count": 4
              },
              {
                "unit": "archer",
                "count": 4
              }
            ],
            "startingWorkers": 5,
            "startingResources": {
              "minerals": 450,
              "gas": 75
            },
            "startingTech": 1,
            "startingBuildings": [
              {
                "id": "opening-supply-1",
                "building": "supply"
              },
              {
                "id": "opening-supply-2",
                "building": "supply"
              },
              {
                "id": "opening-supply-3",
                "building": "supply"
              }
            ],
            "defenseCards": [],
            "techCap": 1
          },
          "enemy": {
            "availableUnits": [
              "swordsman",
              "archer",
              "pikeman"
            ],
            "startingUnits": [
              {
                "unit": "swordsman",
                "count": 7
              },
              {
                "unit": "pikeman",
                "count": 5
              },
              {
                "unit": "archer",
                "count": 5
              }
            ],
            "startingWorkers": 5,
            "startingResources": {
              "minerals": 450,
              "gas": 75
            },
            "startingTech": 1,
            "startingBuildings": [],
            "defenseCards": [],
            "techCap": 1,
            "aiProfile": "standard",
            "offense": {
              "firstAttackMs": 45000,
              "regroupMs": 18000,
              "attackSize": 12,
              "counterattackPoints": [],
              "productionLimit": 2
            }
          },
          "map": {
            "type": "manual",
            "width": 3600,
            "height": 4200,
            "biome": "flower-border",
            "spawns": {
              "host": [
                0.14,
                0.84
              ],
              "guest": [
                0.86,
                0.16
              ]
            },
            "lanes": {
              "top": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.34,
                  0.67
                ],
                [
                  0.5,
                  0.62
                ],
                [
                  0.5,
                  0.54
                ],
                [
                  0.5,
                  0.46
                ],
                [
                  0.65,
                  0.36
                ],
                [
                  0.86,
                  0.16
                ]
              ],
              "mid": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.34,
                  0.67
                ],
                [
                  0.5,
                  0.54
                ],
                [
                  0.55,
                  0.43
                ],
                [
                  0.72,
                  0.32
                ],
                [
                  0.86,
                  0.16
                ]
              ],
              "bot": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.41,
                  0.72
                ],
                [
                  0.64,
                  0.64
                ],
                [
                  0.76,
                  0.6
                ],
                [
                  0.76,
                  0.48
                ],
                [
                  0.75,
                  0.32
                ],
                [
                  0.86,
                  0.16
                ]
              ]
            },
            "capturePoints": [],
            "terrain": {
              "river": {
                "points": [
                  [
                    0.12,
                    0.54
                  ],
                  [
                    0.88,
                    0.54
                  ]
                ],
                "halfWidth": 0.02
              },
              "bridges": [
                {
                  "id": "mid-bridge",
                  "position": [
                    0.5,
                    0.54
                  ],
                  "angle": 1.5707963267948966,
                  "level": 0,
                  "halfLength": 0.07,
                  "halfWidth": 0.03
                }
              ],
              "layers": [
                {
                  "id": "river-channel",
                  "level": -1,
                  "points": [
                    [
                      0.06,
                      0.5
                    ],
                    [
                      0.94,
                      0.5
                    ],
                    [
                      0.94,
                      0.58
                    ],
                    [
                      0.06,
                      0.58
                    ]
                  ],
                  "innerPoints": [
                    [
                      0.1,
                      0.517
                    ],
                    [
                      0.9,
                      0.517
                    ],
                    [
                      0.9,
                      0.563
                    ],
                    [
                      0.1,
                      0.563
                    ]
                  ]
                }
              ],
              "ramps": [],
              "blockers": [],
              "roads": [
                {
                  "id": "south-retreat-road",
                  "points": [
                    [
                      0.14,
                      0.84
                    ],
                    [
                      0.27,
                      0.76
                    ],
                    [
                      0.34,
                      0.67
                    ],
                    [
                      0.47,
                      0.65
                    ],
                    [
                      0.5,
                      0.62
                    ],
                    [
                      0.5,
                      0.54
                    ],
                    [
                      0.5,
                      0.46
                    ]
                  ],
                  "width": 0.065
                },
                {
                  "id": "north-maneuver-road",
                  "points": [
                    [
                      0.5,
                      0.46
                    ],
                    [
                      0.55,
                      0.43
                    ],
                    [
                      0.72,
                      0.32
                    ],
                    [
                      0.86,
                      0.16
                    ]
                  ],
                  "width": 0.07
                }
              ]
            },
            "content": {
              "resourcePlacement": "objective-auto"
            },
            "garrisons": [
              {
                "id": "skirm-rescue",
                "label": "후퇴하는 포자사수",
                "position": [
                  0.34,
                  0.67
                ],
                "faction": "player",
                "composition": [
                  {
                    "unit": "skirmisher",
                    "count": 6
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              },
              {
                "id": "slow-wall",
                "label": "느린 중장갑 수비대",
                "position": [
                  0.55,
                  0.48
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "tank",
                    "count": 3
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              }
            ],
            "attackForces": [],
            "structures": []
          },
          "regions": {
            "skirm": {
              "center": [
                0.34,
                0.67
              ],
              "radius": 0.1
            },
            "field": {
              "center": [
                0.55,
                0.48
              ],
              "radius": 0.14
            }
          },
          "objectives": [
            {
              "id": "join",
              "text": "남쪽의 넓은 강변에서 포자사수와 접촉하십시오.",
              "state": "active"
            },
            {
              "id": "cross",
              "text": "공간을 활용해 중장갑 수비대를 무너뜨리십시오.",
              "state": "pending"
            }
          ],
          "flags": {},
          "events": [
            {
              "id": "join-skirm",
              "when": {
                "type": "enterRegion",
                "region": "skirm",
                "count": 1
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "join"
                },
                {
                  "type": "setFaction",
                  "group": "skirm-rescue",
                  "faction": "player"
                },
                {
                  "type": "unlockUnit",
                  "unit": "skirmisher"
                },
                {
                  "type": "unlockUnit",
                  "unit": "skirmisher",
                  "side": "enemy"
                },
                {
                  "type": "toast",
                  "text": "포자사수가 합류했습니다. 거리를 유지할 공간이 있을수록 강합니다."
                },
                {
                  "type": "setObjective",
                  "id": "cross",
                  "text": "포자사수의 거리 조절을 활용해 느린 적을 상대하고 다리를 건너십시오.",
                  "state": "active"
                },
                {
                  "type": "ping",
                  "region": "field"
                },
                {
                  "type": "setFlag",
                  "id": "lessonComplete",
                  "value": true
                }
              ]
            },
            {
              "id": "mission-victory",
              "when": {
                "all": [
                  {
                    "type": "flag",
                    "id": "lessonComplete",
                    "equals": true
                  },
                  {
                    "type": "structureCount",
                    "side": "enemy",
                    "types": [
                      "base"
                    ],
                    "op": "=",
                    "value": 0
                  }
                ]
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "cross"
                },
                {
                  "type": "victory"
                }
              ]
            }
          ],
          "presentation": {
            "opening": [
              "강은 병력을 느리게 하지만, 넓은 평야는 기동 사수에게 시간을 준다."
            ],
            "outro": [
              "지형은 같은 병종의 강함도 바꾼다."
            ]
          }
        }
      },
      {
        "id": "frontier-05-two-flags",
        "title": "5. 두 개의 깃발",
        "mission": {
          "schemaVersion": 7,
          "missionId": "frontier-05-two-flags",
          "title": "5. 두 개의 깃발",
          "briefing": "중앙 언덕을 돌아가는 북쪽 긴 길과 남쪽 빠른 길이 두 거점으로 이어집니다. 민들레 주자대와 합류해 병력을 나누십시오. 적도 같은 해금 병종과 테크 안에서 채집·건설·생산합니다. 생산시설을 세워 전선을 유지하십시오. 적은 병력을 모아 반복 공격합니다. 점령한 거점에는 반격이 올 수 있습니다.",
          "playerRole": "host",
          "faction": "frontier",
          "seed": 690105,
          "victory": {
            "type": "scripted"
          },
          "player": {
            "availableUnits": [
              "swordsman",
              "archer",
              "pikeman",
              "skirmisher"
            ],
            "startingUnits": [
              {
                "unit": "swordsman",
                "count": 5
              },
              {
                "unit": "pikeman",
                "count": 4
              },
              {
                "unit": "archer",
                "count": 4
              }
            ],
            "startingWorkers": 5,
            "startingResources": {
              "minerals": 500,
              "gas": 100
            },
            "startingTech": 1,
            "startingBuildings": [
              {
                "id": "opening-supply-1",
                "building": "supply"
              },
              {
                "id": "opening-supply-2",
                "building": "supply"
              },
              {
                "id": "opening-supply-3",
                "building": "supply"
              }
            ],
            "defenseCards": [],
            "techCap": 1
          },
          "enemy": {
            "availableUnits": [
              "swordsman",
              "archer",
              "pikeman",
              "skirmisher"
            ],
            "startingUnits": [
              {
                "unit": "swordsman",
                "count": 7
              },
              {
                "unit": "pikeman",
                "count": 5
              },
              {
                "unit": "archer",
                "count": 5
              }
            ],
            "startingWorkers": 5,
            "startingResources": {
              "minerals": 500,
              "gas": 100
            },
            "startingTech": 1,
            "startingBuildings": [],
            "defenseCards": [],
            "techCap": 1,
            "aiProfile": "standard",
            "offense": {
              "firstAttackMs": 40000,
              "regroupMs": 18000,
              "attackSize": 12,
              "counterattackPoints": [
                "north",
                "south"
              ],
              "productionLimit": 2
            }
          },
          "map": {
            "type": "manual",
            "width": 3600,
            "height": 4200,
            "biome": "flower-border",
            "spawns": {
              "host": [
                0.14,
                0.84
              ],
              "guest": [
                0.86,
                0.16
              ]
            },
            "lanes": {
              "top": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.23,
                  0.72
                ],
                [
                  0.19,
                  0.59
                ],
                [
                  0.2,
                  0.43
                ],
                [
                  0.34,
                  0.43
                ],
                [
                  0.46,
                  0.33
                ],
                [
                  0.72,
                  0.33
                ],
                [
                  0.86,
                  0.16
                ]
              ],
              "mid": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.27,
                  0.73
                ],
                [
                  0.39,
                  0.64
                ],
                [
                  0.54,
                  0.59
                ],
                [
                  0.54,
                  0.48
                ],
                [
                  0.65,
                  0.39
                ],
                [
                  0.86,
                  0.16
                ]
              ],
              "bot": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.27,
                  0.73
                ],
                [
                  0.49,
                  0.7
                ],
                [
                  0.72,
                  0.66
                ],
                [
                  0.77,
                  0.45
                ],
                [
                  0.76,
                  0.32
                ],
                [
                  0.86,
                  0.16
                ]
              ]
            },
            "capturePoints": [
              {
                "id": "north",
                "position": [
                  0.34,
                  0.43
                ],
                "lane": "top",
                "label": "북부 거점",
                "stage": 1
              },
              {
                "id": "south",
                "position": [
                  0.49,
                  0.7
                ],
                "lane": "bot",
                "label": "남부 거점",
                "stage": 1
              }
            ],
            "terrain": {
              "river": {
                "points": [],
                "halfWidth": 0.03
              },
              "bridges": [],
              "layers": [
                {
                  "id": "fork-hill",
                  "level": 1,
                  "points": [
                    [
                      0.42,
                      0.47
                    ],
                    [
                      0.67,
                      0.47
                    ],
                    [
                      0.67,
                      0.6
                    ],
                    [
                      0.42,
                      0.6
                    ]
                  ]
                }
              ],
              "ramps": [
                {
                  "id": "fork-north-ramp",
                  "layerId": "fork-hill",
                  "edge": 0,
                  "t0": 0.2,
                  "t1": 0.8,
                  "run": 0.025
                },
                {
                  "id": "fork-south-ramp",
                  "layerId": "fork-hill",
                  "edge": 2,
                  "t0": 0.2,
                  "t1": 0.8,
                  "run": 0.025
                }
              ],
              "blockers": [],
              "roads": [
                {
                  "id": "north-long-road",
                  "points": [
                    [
                      0.14,
                      0.84
                    ],
                    [
                      0.23,
                      0.72
                    ],
                    [
                      0.19,
                      0.59
                    ],
                    [
                      0.2,
                      0.43
                    ],
                    [
                      0.34,
                      0.43
                    ],
                    [
                      0.46,
                      0.33
                    ],
                    [
                      0.72,
                      0.33
                    ],
                    [
                      0.86,
                      0.16
                    ]
                  ],
                  "width": 0.055
                },
                {
                  "id": "south-fast-road",
                  "points": [
                    [
                      0.14,
                      0.84
                    ],
                    [
                      0.27,
                      0.73
                    ],
                    [
                      0.49,
                      0.7
                    ],
                    [
                      0.72,
                      0.66
                    ],
                    [
                      0.77,
                      0.45
                    ],
                    [
                      0.76,
                      0.32
                    ],
                    [
                      0.86,
                      0.16
                    ]
                  ],
                  "width": 0.055
                }
              ]
            },
            "content": {
              "resourcePlacement": "objective-auto"
            },
            "garrisons": [
              {
                "id": "dandy-rescue",
                "label": "민들레 주자대",
                "position": [
                  0.27,
                  0.73
                ],
                "faction": "player",
                "composition": [
                  {
                    "unit": "dandelion",
                    "count": 10
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              },
              {
                "id": "north-guard",
                "label": "북부 거점 수비대",
                "position": [
                  0.34,
                  0.43
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "shellbug",
                    "count": 6
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              },
              {
                "id": "south-guard",
                "label": "남부 거점 수비대",
                "position": [
                  0.49,
                  0.7
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "swordsman",
                    "count": 5
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              }
            ],
            "attackForces": [],
            "structures": []
          },
          "regions": {
            "dandy": {
              "center": [
                0.27,
                0.73
              ],
              "radius": 0.1
            }
          },
          "objectives": [
            {
              "id": "join",
              "text": "민들레 주자대와 접촉하십시오.",
              "state": "active"
            },
            {
              "id": "capture",
              "text": "중앙 언덕 양쪽의 북부·남부 거점을 모두 점령하십시오.",
              "state": "pending"
            },
            {
              "id": "finish",
              "text": "두 거점을 연결한 뒤 적 본진을 파괴하십시오.",
              "state": "pending"
            }
          ],
          "flags": {},
          "events": [
            {
              "id": "join-dandy",
              "when": {
                "type": "enterRegion",
                "region": "dandy",
                "count": 1
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "join"
                },
                {
                  "type": "setFaction",
                  "group": "dandy-rescue",
                  "faction": "player"
                },
                {
                  "type": "unlockUnit",
                  "unit": "dandelion"
                },
                {
                  "type": "unlockUnit",
                  "unit": "dandelion",
                  "side": "enemy"
                },
                {
                  "type": "toast",
                  "text": "민들레 주자대가 합류했습니다. 빠른 병력으로 빈 전선을 먼저 차지할 수 있습니다."
                },
                {
                  "type": "setObjective",
                  "id": "capture",
                  "text": "주력과 기동대를 나누어 북부·남부 거점을 모두 점령하십시오.",
                  "state": "active"
                },
                {
                  "type": "setFlag",
                  "id": "lessonComplete",
                  "value": true
                }
              ]
            },
            {
              "id": "both-captured",
              "when": {
                "all": [
                  {
                    "type": "regionCaptured",
                    "id": "north"
                  },
                  {
                    "type": "regionCaptured",
                    "id": "south"
                  }
                ]
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "capture"
                },
                {
                  "type": "toast",
                  "text": "두 전선이 연결됐습니다. 이제 적 본진으로 진격하십시오."
                },
                {
                  "type": "setObjective",
                  "id": "finish",
                  "text": "두 거점을 연결했습니다. 적 본진을 파괴하십시오.",
                  "state": "active"
                },
                {
                  "type": "setFlag",
                  "id": "frontsComplete",
                  "value": true
                }
              ]
            },
            {
              "id": "mission-victory",
              "when": {
                "all": [
                  {
                    "type": "flag",
                    "id": "lessonComplete",
                    "equals": true
                  },
                  {
                    "type": "flag",
                    "id": "frontsComplete",
                    "equals": true
                  },
                  {
                    "type": "structureCount",
                    "side": "enemy",
                    "types": [
                      "base"
                    ],
                    "op": "=",
                    "value": 0
                  }
                ]
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "finish"
                },
                {
                  "type": "victory"
                }
              ]
            }
          ],
          "presentation": {
            "opening": [
              "전선이 둘로 갈라졌다.",
              "한 깃발에 모든 병력을 묶어두면 다른 곳을 잃는다."
            ],
            "outro": [
              "빠른 병력은 전투력만이 아니라 시간을 산다."
            ]
          }
        }
      },
      {
        "id": "frontier-06-wounded-road",
        "title": "6. 상처 입은 길",
        "mission": {
          "schemaVersion": 7,
          "missionId": "frontier-06-wounded-road",
          "title": "6. 상처 입은 길",
          "briefing": "폐허 사이의 넓은 도로를 따라 첫 방어선을 돌파하고 이슬치유사와 합류하십시오. 후방 공간에서 회복한 뒤 다음 전선을 밀어내십시오. 적도 같은 해금 병종과 테크 안에서 채집·건설·생산합니다. 생산시설을 세워 전선을 유지하십시오. 적은 병력을 모아 반복 공격합니다.",
          "playerRole": "host",
          "faction": "frontier",
          "seed": 690106,
          "victory": {
            "type": "scripted"
          },
          "player": {
            "availableUnits": [
              "swordsman",
              "archer",
              "pikeman",
              "skirmisher",
              "dandelion"
            ],
            "startingUnits": [
              {
                "unit": "swordsman",
                "count": 6
              },
              {
                "unit": "pikeman",
                "count": 4
              },
              {
                "unit": "archer",
                "count": 5
              }
            ],
            "startingWorkers": 5,
            "startingResources": {
              "minerals": 425,
              "gas": 225
            },
            "startingTech": 2,
            "startingBuildings": [
              {
                "id": "academy",
                "building": "academy"
              },
              {
                "id": "opening-supply-1",
                "building": "supply"
              },
              {
                "id": "opening-supply-2",
                "building": "supply"
              },
              {
                "id": "opening-supply-3",
                "building": "supply"
              }
            ],
            "defenseCards": [],
            "techCap": 2
          },
          "enemy": {
            "availableUnits": [
              "swordsman",
              "archer",
              "pikeman",
              "skirmisher",
              "dandelion"
            ],
            "startingUnits": [
              {
                "unit": "swordsman",
                "count": 8
              },
              {
                "unit": "pikeman",
                "count": 5
              },
              {
                "unit": "archer",
                "count": 7
              }
            ],
            "startingWorkers": 5,
            "startingResources": {
              "minerals": 425,
              "gas": 225
            },
            "startingTech": 2,
            "startingBuildings": [
              {
                "id": "academy",
                "building": "academy"
              }
            ],
            "defenseCards": [],
            "techCap": 2,
            "aiProfile": "standard",
            "offense": {
              "firstAttackMs": 40000,
              "regroupMs": 15000,
              "attackSize": 14,
              "counterattackPoints": [],
              "productionLimit": 3
            }
          },
          "map": {
            "type": "manual",
            "width": 3600,
            "height": 4200,
            "biome": "flower-border",
            "spawns": {
              "host": [
                0.14,
                0.84
              ],
              "guest": [
                0.86,
                0.16
              ]
            },
            "lanes": {
              "top": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.28,
                  0.73
                ],
                [
                  0.36,
                  0.64
                ],
                [
                  0.43,
                  0.57
                ],
                [
                  0.54,
                  0.46
                ],
                [
                  0.66,
                  0.34
                ],
                [
                  0.86,
                  0.16
                ]
              ],
              "mid": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.36,
                  0.64
                ],
                [
                  0.43,
                  0.57
                ],
                [
                  0.54,
                  0.46
                ],
                [
                  0.66,
                  0.34
                ],
                [
                  0.86,
                  0.16
                ]
              ],
              "bot": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.39,
                  0.75
                ],
                [
                  0.49,
                  0.67
                ],
                [
                  0.55,
                  0.56
                ],
                [
                  0.6,
                  0.43
                ],
                [
                  0.66,
                  0.34
                ],
                [
                  0.86,
                  0.16
                ]
              ]
            },
            "capturePoints": [],
            "terrain": {
              "river": {
                "points": [],
                "halfWidth": 0.03
              },
              "bridges": [],
              "layers": [
                {
                  "id": "ruin-overlook",
                  "level": 1,
                  "points": [
                    [
                      0.72,
                      0.51
                    ],
                    [
                      0.84,
                      0.48
                    ],
                    [
                      0.88,
                      0.61
                    ],
                    [
                      0.76,
                      0.64
                    ]
                  ]
                }
              ],
              "ramps": [
                {
                  "id": "ruin-overlook-ramp",
                  "layerId": "ruin-overlook",
                  "edge": 3,
                  "t0": 0.2,
                  "t1": 0.8,
                  "run": 0.03
                }
              ],
              "blockers": [
                {
                  "id": "roadside-west-ruins",
                  "kind": "roots",
                  "points": [
                    [
                      0.23,
                      0.48
                    ],
                    [
                      0.29,
                      0.47
                    ],
                    [
                      0.31,
                      0.52
                    ],
                    [
                      0.28,
                      0.58
                    ],
                    [
                      0.23,
                      0.57
                    ]
                  ],
                  "blocksMovement": true,
                  "blocksVision": true,
                  "blocksProjectile": false,
                  "blocksAirVision": false
                },
                {
                  "id": "roadside-east-ruins",
                  "kind": "roots",
                  "points": [
                    [
                      0.59,
                      0.59
                    ],
                    [
                      0.66,
                      0.59
                    ],
                    [
                      0.69,
                      0.65
                    ],
                    [
                      0.63,
                      0.68
                    ]
                  ],
                  "blocksMovement": true,
                  "blocksVision": true,
                  "blocksProjectile": false,
                  "blocksAirVision": false
                },
                {
                  "id": "northern-ruins",
                  "kind": "roots",
                  "points": [
                    [
                      0.46,
                      0.28
                    ],
                    [
                      0.52,
                      0.27
                    ],
                    [
                      0.56,
                      0.33
                    ],
                    [
                      0.5,
                      0.36
                    ]
                  ],
                  "blocksMovement": true,
                  "blocksVision": true,
                  "blocksProjectile": false,
                  "blocksAirVision": false
                }
              ],
              "roads": [
                {
                  "id": "wounded-road",
                  "points": [
                    [
                      0.14,
                      0.84
                    ],
                    [
                      0.28,
                      0.73
                    ],
                    [
                      0.36,
                      0.64
                    ],
                    [
                      0.43,
                      0.57
                    ],
                    [
                      0.54,
                      0.46
                    ],
                    [
                      0.66,
                      0.34
                    ],
                    [
                      0.76,
                      0.26
                    ],
                    [
                      0.86,
                      0.16
                    ]
                  ],
                  "width": 0.07
                }
              ]
            },
            "content": {
              "resourcePlacement": "objective-auto"
            },
            "garrisons": [
              {
                "id": "medic-rescue",
                "label": "부상자를 돌보는 이슬치유사",
                "position": [
                  0.43,
                  0.57
                ],
                "faction": "player",
                "composition": [
                  {
                    "unit": "medic",
                    "count": 4
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              },
              {
                "id": "line-one",
                "label": "첫 방어선",
                "position": [
                  0.36,
                  0.64
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "shellbug",
                    "count": 6
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              },
              {
                "id": "line-two",
                "label": "두 번째 방어선",
                "position": [
                  0.54,
                  0.46
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "swordsman",
                    "count": 6
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              }
            ],
            "attackForces": [
              {
                "id": "cloak-wave",
                "label": "은신 습격대",
                "position": [
                  0.66,
                  0.34
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "mantis",
                    "count": 5
                  }
                ],
                "formation": "cluster",
                "spawnOnStart": false
              }
            ],
            "structures": []
          },
          "regions": {
            "medics": {
              "center": [
                0.43,
                0.57
              ],
              "radius": 0.1
            }
          },
          "objectives": [
            {
              "id": "join",
              "text": "폐허 도로의 이슬치유사와 접촉하십시오.",
              "state": "active"
            },
            {
              "id": "survive",
              "text": "치유와 탐지를 활용해 연속 전투를 버티십시오.",
              "state": "pending"
            }
          ],
          "flags": {},
          "events": [
            {
              "id": "join-medics",
              "when": {
                "type": "enterRegion",
                "region": "medics",
                "count": 1
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "join"
                },
                {
                  "type": "setFaction",
                  "group": "medic-rescue",
                  "faction": "player"
                },
                {
                  "type": "unlockUnit",
                  "unit": "medic"
                },
                {
                  "type": "unlockUnit",
                  "unit": "medic",
                  "side": "enemy"
                },
                {
                  "type": "toast",
                  "text": "이슬치유사가 합류했습니다. 부상병을 회복시키고 가까운 은신 적을 탐지합니다."
                },
                {
                  "type": "setObjective",
                  "id": "survive",
                  "text": "이슬치유사를 생산해 병력을 유지하십시오.",
                  "state": "active"
                },
                {
                  "type": "spawnObject",
                  "objectId": "cloak-wave"
                },
                {
                  "type": "order",
                  "group": "cloak-wave",
                  "order": "attack",
                  "target": "playerBase"
                },
                {
                  "type": "setFlag",
                  "id": "lessonComplete",
                  "value": true
                }
              ]
            },
            {
              "id": "mission-victory",
              "when": {
                "all": [
                  {
                    "type": "flag",
                    "id": "lessonComplete",
                    "equals": true
                  },
                  {
                    "type": "structureCount",
                    "side": "enemy",
                    "types": [
                      "base"
                    ],
                    "op": "=",
                    "value": 0
                  }
                ]
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "survive"
                },
                {
                  "type": "victory"
                }
              ]
            }
          ],
          "presentation": {
            "opening": [
              "전선은 승리해도 닳아간다.",
              "다음 전투까지 살아남는 병력이 필요하다."
            ],
            "outro": [
              "살아남은 병력이 다음 전투의 시작점이 된다."
            ]
          }
        }
      },
      {
        "id": "frontier-07-frontier-line",
        "title": "7. 개척선",
        "mission": {
          "schemaVersion": 7,
          "missionId": "frontier-07-frontier-line",
          "title": "7. 개척선",
          "briefing": "서쪽의 넓은 중장갑 전장, 동쪽 고지, 중앙 다리의 세 전선을 확보하십시오. 두 다리와 완만한 동쪽 강둑을 이용해 병력을 나누고 북쪽 본진으로 진격하십시오. 적도 같은 해금 병종과 테크 안에서 채집·건설·생산합니다. 생산시설을 세워 전선을 유지하십시오. 적은 병력을 모아 반복 공격합니다. 점령한 거점에는 반격이 올 수 있습니다.",
          "playerRole": "host",
          "faction": "frontier",
          "seed": 690107,
          "victory": {
            "type": "scripted"
          },
          "player": {
            "availableUnits": [
              "swordsman",
              "archer",
              "pikeman",
              "skirmisher",
              "dandelion",
              "medic"
            ],
            "startingUnits": [
              {
                "unit": "swordsman",
                "count": 6
              },
              {
                "unit": "pikeman",
                "count": 4
              },
              {
                "unit": "archer",
                "count": 4
              },
              {
                "unit": "medic",
                "count": 2
              }
            ],
            "startingWorkers": 5,
            "startingResources": {
              "minerals": 650,
              "gas": 300
            },
            "startingTech": 2,
            "startingBuildings": [
              {
                "id": "academy",
                "building": "academy"
              },
              {
                "id": "opening-supply-1",
                "building": "supply"
              },
              {
                "id": "opening-supply-2",
                "building": "supply"
              },
              {
                "id": "opening-supply-3",
                "building": "supply"
              }
            ],
            "defenseCards": [],
            "techCap": 2
          },
          "enemy": {
            "availableUnits": [
              "swordsman",
              "archer",
              "pikeman",
              "skirmisher",
              "dandelion",
              "medic"
            ],
            "startingUnits": [
              {
                "unit": "swordsman",
                "count": 8
              },
              {
                "unit": "pikeman",
                "count": 5
              },
              {
                "unit": "archer",
                "count": 5
              },
              {
                "unit": "medic",
                "count": 3
              }
            ],
            "startingWorkers": 5,
            "startingResources": {
              "minerals": 650,
              "gas": 300
            },
            "startingTech": 2,
            "startingBuildings": [
              {
                "id": "academy",
                "building": "academy"
              }
            ],
            "defenseCards": [],
            "techCap": 2,
            "aiProfile": "standard",
            "offense": {
              "firstAttackMs": 90000,
              "regroupMs": 35000,
              "attackSize": 16,
              "counterattackPoints": [
                "west",
                "east",
                "center"
              ],
              "productionLimit": 2
            }
          },
          "map": {
            "type": "manual",
            "width": 3600,
            "height": 4200,
            "biome": "flower-border",
            "spawns": {
              "host": [
                0.14,
                0.84
              ],
              "guest": [
                0.86,
                0.16
              ]
            },
            "lanes": {
              "top": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.23,
                  0.7
                ],
                [
                  0.29,
                  0.57
                ],
                [
                  0.31,
                  0.49
                ],
                [
                  0.44,
                  0.38
                ],
                [
                  0.66,
                  0.29
                ],
                [
                  0.72,
                  0.24
                ],
                [
                  0.86,
                  0.16
                ]
              ],
              "mid": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.38,
                  0.72
                ],
                [
                  0.38,
                  0.63
                ],
                [
                  0.52,
                  0.63
                ],
                [
                  0.52,
                  0.57
                ],
                [
                  0.52,
                  0.46
                ],
                [
                  0.65,
                  0.37
                ],
                [
                  0.78,
                  0.3
                ],
                [
                  0.86,
                  0.16
                ]
              ],
              "bot": [
                [
                  0.14,
                  0.84
                ],
                [
                  0.35,
                  0.85
                ],
                [
                  0.55,
                  0.78
                ],
                [
                  0.56,
                  0.7
                ],
                [
                  0.65,
                  0.7
                ],
                [
                  0.75,
                  0.7
                ],
                [
                  0.8,
                  0.57
                ],
                [
                  0.8,
                  0.34
                ],
                [
                  0.8,
                  0.3
                ],
                [
                  0.86,
                  0.16
                ]
              ]
            },
            "capturePoints": [
              {
                "id": "west",
                "position": [
                  0.31,
                  0.49
                ],
                "lane": "top",
                "label": "서부 거점",
                "stage": 1
              },
              {
                "id": "east",
                "position": [
                  0.56,
                  0.7
                ],
                "lane": "bot",
                "label": "동부 거점",
                "stage": 1
              },
              {
                "id": "center",
                "position": [
                  0.52,
                  0.46
                ],
                "lane": "mid",
                "label": "중앙 거점",
                "stage": 2
              }
            ],
            "terrain": {
              "river": {
                "points": [
                  [
                    0.12,
                    0.57
                  ],
                  [
                    0.88,
                    0.57
                  ]
                ],
                "halfWidth": 0.015
              },
              "bridges": [
                {
                  "id": "center-bridge",
                  "position": [
                    0.52,
                    0.57
                  ],
                  "angle": 1.5707963267948966,
                  "level": 0,
                  "halfLength": 0.065,
                  "halfWidth": 0.03
                },
                {
                  "id": "west-bridge",
                  "position": [
                    0.29,
                    0.57
                  ],
                  "angle": 1.5707963267948966,
                  "level": 0,
                  "halfLength": 0.065,
                  "halfWidth": 0.035
                }
              ],
              "layers": [
                {
                  "id": "frontier-channel",
                  "level": -1,
                  "points": [
                    [
                      0.06,
                      0.54
                    ],
                    [
                      0.94,
                      0.54
                    ],
                    [
                      0.94,
                      0.6
                    ],
                    [
                      0.06,
                      0.6
                    ]
                  ],
                  "innerPoints": [
                    [
                      0.1,
                      0.553
                    ],
                    [
                      0.9,
                      0.553
                    ],
                    [
                      0.9,
                      0.587
                    ],
                    [
                      0.1,
                      0.587
                    ]
                  ]
                },
                {
                  "id": "east-post",
                  "level": 1,
                  "points": [
                    [
                      0.4,
                      0.64
                    ],
                    [
                      0.71,
                      0.64
                    ],
                    [
                      0.71,
                      0.83
                    ],
                    [
                      0.4,
                      0.83
                    ]
                  ]
                },
                {
                  "id": "enemy-rise",
                  "level": 1,
                  "points": [
                    [
                      0.68,
                      0.08
                    ],
                    [
                      0.96,
                      0.08
                    ],
                    [
                      0.96,
                      0.32
                    ],
                    [
                      0.68,
                      0.32
                    ]
                  ]
                }
              ],
              "ramps": [
                {
                  "id": "east-west-approach",
                  "layerId": "east-post",
                  "edge": 3,
                  "t0": 0.18,
                  "t1": 0.82,
                  "run": 0.04
                },
                {
                  "id": "east-south-approach",
                  "layerId": "east-post",
                  "edge": 2,
                  "t0": 0.18,
                  "t1": 0.82,
                  "run": 0.035
                },
                {
                  "id": "enemy-west-approach",
                  "layerId": "enemy-rise",
                  "edge": 3,
                  "t0": 0.18,
                  "t1": 0.82,
                  "run": 0.03
                },
                {
                  "id": "enemy-south-approach",
                  "layerId": "enemy-rise",
                  "edge": 2,
                  "t0": 0.15,
                  "t1": 0.85,
                  "run": 0.025
                },
                {
                  "id": "east-east-exit",
                  "layerId": "east-post",
                  "edge": 1,
                  "t0": 0.18,
                  "t1": 0.82,
                  "run": 0.035
                }
              ],
              "blockers": [],
              "roads": [
                {
                  "id": "west-heavy-road",
                  "points": [
                    [
                      0.14,
                      0.84
                    ],
                    [
                      0.23,
                      0.7
                    ],
                    [
                      0.29,
                      0.64
                    ],
                    [
                      0.29,
                      0.57
                    ],
                    [
                      0.29,
                      0.51
                    ],
                    [
                      0.31,
                      0.49
                    ],
                    [
                      0.44,
                      0.38
                    ],
                    [
                      0.66,
                      0.29
                    ],
                    [
                      0.72,
                      0.24
                    ],
                    [
                      0.86,
                      0.16
                    ]
                  ],
                  "width": 0.075
                },
                {
                  "id": "center-charge-road",
                  "points": [
                    [
                      0.14,
                      0.84
                    ],
                    [
                      0.35,
                      0.8
                    ],
                    [
                      0.38,
                      0.72
                    ],
                    [
                      0.38,
                      0.63
                    ],
                    [
                      0.52,
                      0.63
                    ],
                    [
                      0.52,
                      0.57
                    ],
                    [
                      0.52,
                      0.46
                    ],
                    [
                      0.65,
                      0.37
                    ],
                    [
                      0.78,
                      0.34
                    ],
                    [
                      0.78,
                      0.3
                    ],
                    [
                      0.86,
                      0.16
                    ]
                  ],
                  "width": 0.065
                },
                {
                  "id": "east-post-road",
                  "points": [
                    [
                      0.14,
                      0.84
                    ],
                    [
                      0.35,
                      0.85
                    ],
                    [
                      0.55,
                      0.84
                    ],
                    [
                      0.55,
                      0.78
                    ],
                    [
                      0.56,
                      0.7
                    ],
                    [
                      0.65,
                      0.7
                    ],
                    [
                      0.75,
                      0.7
                    ],
                    [
                      0.8,
                      0.63
                    ],
                    [
                      0.8,
                      0.57
                    ],
                    [
                      0.8,
                      0.49
                    ],
                    [
                      0.8,
                      0.34
                    ],
                    [
                      0.8,
                      0.3
                    ],
                    [
                      0.86,
                      0.16
                    ]
                  ],
                  "width": 0.065
                }
              ]
            },
            "content": {
              "resourcePlacement": "objective-auto"
            },
            "garrisons": [
              {
                "id": "center-charge",
                "label": "중앙 돌격대",
                "position": [
                  0.52,
                  0.46
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "dandelion",
                    "count": 10
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              },
              {
                "id": "west-heavy",
                "label": "서부 중장갑",
                "position": [
                  0.31,
                  0.49
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "tank",
                    "count": 3
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              },
              {
                "id": "east-line",
                "label": "동부 수비대",
                "position": [
                  0.56,
                  0.7
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "swordsman",
                    "count": 5
                  },
                  {
                    "unit": "archer",
                    "count": 4
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              },
              {
                "id": "final-guard",
                "label": "적 본진 방어대",
                "position": [
                  0.75,
                  0.27
                ],
                "faction": "enemy",
                "composition": [
                  {
                    "unit": "shellbug",
                    "count": 8
                  },
                  {
                    "unit": "archer",
                    "count": 5
                  }
                ],
                "formation": "cluster",
                "guardRadius": 0.08,
                "spread": 0.018,
                "spawnOnStart": true
              }
            ],
            "attackForces": [],
            "structures": []
          },
          "regions": {},
          "objectives": [
            {
              "id": "fronts",
              "text": "서부 평야·동부 고지·중앙 다리 북쪽의 거점을 확보하십시오.",
              "state": "active"
            },
            {
              "id": "final",
              "text": "개척선을 연결한 뒤 적 본진을 파괴하십시오.",
              "state": "pending"
            }
          ],
          "flags": {},
          "events": [
            {
              "id": "all-fronts",
              "when": {
                "all": [
                  {
                    "type": "regionCaptured",
                    "id": "west"
                  },
                  {
                    "type": "regionCaptured",
                    "id": "east"
                  },
                  {
                    "type": "regionCaptured",
                    "id": "center"
                  }
                ]
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "fronts"
                },
                {
                  "type": "setObjective",
                  "id": "final",
                  "text": "모든 전선을 연결했습니다. 원하는 조합으로 적 본진을 파괴하십시오.",
                  "state": "active"
                },
                {
                  "type": "toast",
                  "text": "개척선이 완성됐습니다. 이제 어떤 병종을 어디에 쓸지는 당신의 판단입니다."
                },
                {
                  "type": "setFlag",
                  "id": "frontsComplete",
                  "value": true
                }
              ]
            },
            {
              "id": "mission-victory",
              "when": {
                "all": [
                  {
                    "type": "flag",
                    "id": "frontsComplete",
                    "equals": true
                  },
                  {
                    "type": "structureCount",
                    "side": "enemy",
                    "types": [
                      "base"
                    ],
                    "op": "=",
                    "value": 0
                  }
                ]
              },
              "delayMs": 0,
              "once": true,
              "actions": [
                {
                  "type": "completeObjective",
                  "id": "final"
                },
                {
                  "type": "victory"
                }
              ]
            }
          ],
          "presentation": {
            "opening": [
              "이제 새로운 병종은 오지 않는다.",
              "지금까지 만난 병력으로 세 전선을 스스로 연결해야 한다."
            ],
            "outro": [
              "흩어진 개척단은 하나의 전선이 되었다.",
              "다음 전장에서는 다른 방식의 문제들이 기다린다."
            ]
          }
        }
      }
    ]
  }
]
};
