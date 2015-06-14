// ==UserScript==
// @name Steam Monster Minigame Auto-upgrade
// @namespace https://github.com/wchill/steamSummerMinigame
// @description A script that buys upgrades in the Steam Monster Minigame for you.
// @version 1.0.15
// @match *://steamcommunity.com/minigame/towerattack*
// @match *://steamcommunity.com//minigame/towerattack*
// @grant none
// @updateURL https://raw.githubusercontent.com/finaldoom/steamSummerMinigame/master/autoUpgradeBuyer.user.js
// @downloadURL https://raw.githubusercontent.com/finaldoom/steamSummerMinigame/master/autoUpgradeBuyer.user.js
// ==/UserScript==

// Updated/made into a userscript from https://gist.github.com/meishuu/f83ee1de2992d5fc656c by /u/FinalDoom

(function(w) {
"use strict";

var upgradeManager = (function() {
  var upgradeManagerPrefilter;
  if (!upgradeManagerPrefilter) {
    // add prefilter on first run
    w.$J.ajaxPrefilter(function() {
      // this will be defined by the end of the script
      upgradeManagerPrefilter.apply(this, arguments);
    });
  }

  /***********
   * Options *
   ***********/

  // On each level, we check for the lane that has the highest enemy DPS.
  // Based on that DPS, if we would not be able to survive more than
  // `survivalTime` seconds, we should buy some armor.
  var survivalTime = 30;

  // To estimate the overall boost in damage from upgrading an element,
  // we sort the elements from highest level to lowest, then multiply
  // each one's level by the number in the corresponding spot to get a
  // weighted average of their effects on your overall damage per click.
  // If you don't prioritize lanes that you're strongest against, this
  // will be [0.25, 0.25, 0.25, 0.25], giving each element an equal
  // scaling. However, this defaults to [0.4, 0.3, 0.2, 0.1] under the
  // assumption that you will spend much more time in lanes with your
  // strongest elements.
  var elementalCoefficients = [0.4, 0.3, 0.2, 0.1];

  // How many elements do you want to upgrade? If we decide to upgrade an
  // element, we'll try to always keep this many as close in levels as we
  // can, and ignore the rest.
  var elementalSpecializations = 1;

  // To include passive DPS upgrades (Auto-fire, etc.) we have to scale
  // down their DPS boosts for an accurate comparison to clicking. This
  // is approximately how many clicks per second we should assume you are
  // consistently doing. If you have an autoclicker, this is easy to set.
  var clickFrequency = 20; // assume maximum of 20

  // Should we buy abilities? Note that Medics will always be bought since
  // it is considered a necessary upgrade.
  var enableBuyAbilities = getPreferenceBoolean("enableBuyAbilities", true);

  // If true, upgrades will be bought automatically. The currently targetted
  // upgrade will be displayed in a box below the game. This can be toggled with
  // a checkbox in that box. When false, you must manually buy the upgrade displayed
  // for it to advance to a new upgrade.
  var enableAutoUpgradeBuying = false;//getPreferenceBoolean("enableAutoUpgradeBuying", false);

  /*****************
   * DO NOT MODIFY *
   *****************/

  /***********
   * GLOBALS *
   ***********/
  var waitingForUpdate = false;

  var next = {
    id: -1,
    cost: 0
  };

  var necessary = [
    { id: 0, level: 1 }, // Light Armor
    { id: 11, level: 1 }, // Medics
    { id: 2, level: 10 }, // Armor Piercing Round
    { id: 1, level: 10 }, // Auto-fire Cannon
  ];

  var gAbilities = [
    11, // Medics
    13, // Good Luck Charms
    16, // Tactical Nuke
    18, // Napalm
    17, // Cluster Bomb
    14, // Metal Detector
    15, // Decrease Cooldowns
    12, // Morale Booster
  ];

  var gHealthUpgrades = [
    0,  // Light Armor
    8,  // Heavy Armor
    20, // Energy Shields
    23, // Personal Training
  ];

  var gAutoUpgrades = [1, 9, 21, 24]; // nobody cares

  var gLuckyShot = 7;

  var gDamageUpgrades = [
    2,  // Armor Piercing Round
    10, // Explosive Rouds
    22, // Railgun
    25, // New Mouse Button
  ];

  var gElementalUpgrades = [3, 4, 5, 6]; // Fire, Water, Earth, Air

  /***********
   * HELPERS *
   ***********/

  function s() {
    return g_Minigame.m_CurrentScene;
  }

  function getUpgrade(id) {
    var result = null;
    if (s().m_rgPlayerUpgrades) {
      s().m_rgPlayerUpgrades.some(function(upgrade) {
        if (upgrade.upgrade == id) {
          result = upgrade;
          return true;
        }
      });
    }
    return result;
  };

  var getElementals = (function() {
    var cache = false;
    return function(refresh) {
      if (!cache || refresh) {
        cache = gElementalUpgrades
          .map(function(id) { return { id: id, level: getUpgrade(id).level }; })
          .sort(function(a, b) { return b.level - a.level; });
      }
      return cache;
    };
  })();

  function getElementalCoefficient(elementals) {
    elementals = elementals || getElementals();
    return s().m_rgTuningData.upgrades[4].multiplier *
      elementals.reduce(function(sum, elemental, i) {
        return sum + elemental.level * elementalCoefficients[i];
      }, 0);
  };

  function canUpgrade(id) {
    // do we even have the upgrade?
    if (!s().bHaveUpgrade(id)) return false;

    // does it have a required upgrade?
    var data = s().m_rgTuningData.upgrades[id];
    var required = data.required_upgrade;
    if (required !== undefined) {
      // is it at the required level to unlock?
      var level = data.required_upgrade_level || 1;
      return (level <= s().GetUpgradeLevel(required));
    }

    // otherwise, we're good to go!
    return true;
  };

  function calculateUpgradeTree(id, level) {
    var base_dpc = s().m_rgTuningData.player.damage_per_click;
    var data = s().m_rgTuningData.upgrades[id];
    var boost = 0;
    var cost = 0;
    var parent;

    var cur_level = getUpgrade(id).level;
    if (level === undefined) level = cur_level + 1;

    // for each missing level, add boost and cost
    for (var level_diff = level - getUpgrade(id).level; level_diff > 0; level_diff--) {
      boost += base_dpc * data.multiplier;
      cost += data.cost * Math.pow(data.cost_exponential_base, level - level_diff);
    }

    // recurse for required upgrades
    var required = data.required_upgrade;
    if (required !== undefined) {
      var parents = calculateUpgradeTree(required, data.required_upgrade_level || 1);
      if (parents.cost > 0) {
        boost += parents.boost;
        cost += parents.cost;
        parent = parents.required || required;
      }
    }

    return { boost: boost, cost: cost, required: parent };
  };

  function necessaryUpgrade() {
    var best = { id: -1, cost: 0 };
    var wanted, id, current;
    while (necessary.length > 0) {
      wanted = necessary[0];
      id = wanted.id;
      current = getUpgrade(id);
      if (current.level < wanted.level) {
        var data = s().m_rgTuningData.upgrades[id];
        best = { id: id, cost: data.cost * Math.pow(data.cost_exponential_base, current.level) };
        break;
      }
      necessary.shift();
    }
    return best;
  };

  function nextAbilityUpgrade() {
    var best = { id: -1, cost: 0 };
    if (enableBuyAbilities) {
      gAbilities.some(function(id) {
        if (canUpgrade(id) && getUpgrade(id).level < 1) {
          best = { id: id, cost: s().m_rgTuningData.upgrades[id].cost };
          return true;
        }
      });
    }
    return best;
  };

  function bestHealthUpgrade() {
    var best = { id: -1, cost: 0, hpg: 0 };
    gHealthUpgrades.forEach(function(id) {
      if (!canUpgrade(id)) return;
      var data = s().m_rgTuningData.upgrades[id];
      var upgrade = getUpgrade(id);
      var cost = data.cost * Math.pow(data.cost_exponential_base, upgrade.level);
      var hpg = s().m_rgTuningData.player.hp * data.multiplier / cost;
      if (hpg >= best.hpg) {
        best = { id: id, cost: cost, hpg: hpg };
      }
    });
    return best;
  };

  function bestDamageUpgrade() {
    var best = { id: -1, cost: 0, dpg: 0 };
    var data, cost, dpg, boost;

    var dpc = s().m_rgPlayerTechTree.damage_per_click;
    var base_dpc = s().m_rgTuningData.player.damage_per_click;
    var critmult = s().m_rgPlayerTechTree.damage_multiplier_crit;
    var critrate = s().m_rgPlayerTechTree.crit_percentage - s().m_rgTuningData.player.crit_percentage;
    var elementals = getElementals();
    var elementalCoefficient = getElementalCoefficient(elementals);

    // lazily check auto damage upgrades; assume we don't care about these
    gAutoUpgrades.forEach(function(id) {
      if (!canUpgrade(id)) return;
      data = s().m_rgTuningData.upgrades[id];
      cost = data.cost * Math.pow(data.cost_exponential_base, getUpgrade(id).level);
      dpg = (s().m_rgPlayerTechTree.base_dps / clickFrequency) * data.multiplier / cost;
      if (dpg >= best.dpg) {
        best = { id: id, cost: cost, dpg: dpg };
      }
    });

    // check Lucky Shot
    if (canUpgrade(gLuckyShot)) { // lazy check because prereq is necessary upgrade
      data = s().m_rgTuningData.upgrades[gLuckyShot];
      boost = dpc * critrate * data.multiplier;
      cost = data.cost * Math.pow(data.cost_exponential_base, getUpgrade(gLuckyShot).level);
      dpg = boost / cost;
      if (dpg >= best.dpg) {
        best = { id: gLuckyShot, cost: cost, dpg: dpg };
      }
    }

    // check click damage upgrades
    gDamageUpgrades.forEach(function(id) {
      var result = calculateUpgradeTree(id);
      boost = result.boost * (critrate * critmult + (1 - critrate) * elementalCoefficient);
      cost = result.cost;
      dpg = boost / cost;
      if (dpg >= best.dpg) {
        if (result.required) {
          id = result.required;
          data = s().m_rgTuningData.upgrades[id];
          cost = data.cost * Math.pow(data.cost_exponential_base, getUpgrade(id).level);
        }
        best = { id: id, cost: cost, dpg: dpg };
      }
    });

    // check elementals
    data = s().m_rgTuningData.upgrades[4];
    var elementalLevels = elementals.reduce(function(sum, elemental) {
      return sum + elemental.level;
    }, 1);
    cost = data.cost * Math.pow(data.cost_exponential_base, elementalLevels);

    // - make new elementals array for testing
    var testElementals = elementals.map(function(elemental) { return { level: elemental.level }; });
    var upgradeLevel = testElementals[elementalSpecializations - 1].level;
    testElementals[elementalSpecializations - 1].level++;
    if (elementalSpecializations > 1) {
      // swap positions if upgraded elemental now has bigger level than (originally) next highest
      var prevElem = testElementals[elementalSpecializations - 2].level;
      if (prevElem <= upgradeLevel) {
        testElementals[elementalSpecializations - 2].level = upgradeLevel + 1;
        testElementals[elementalSpecializations - 1].level = prevElem;
      }
    }

    // - calculate stats
    boost = dpc * (1 - critrate) * (getElementalCoefficient(testElementals) - elementalCoefficient);
    dpg = boost / cost;
    if (dpg > best.dpg) { // give base damage boosters priority
      // find all elements at upgradeLevel and randomly pick one
      var match = elementals.filter(function(elemental) { return elemental.level == upgradeLevel; });
      match = match[Math.floor(Math.random() * match.length)].id;
      best = { id: match, cost: cost, dpg: dpg };
    }

    return best;
  };

  var timeToDie = (function() {
    var cache = false;
    return function(refresh) {
      if (cache === false || refresh) {
        var maxHp = s().m_rgPlayerTechTree.max_hp;
        var enemyDps = s().m_rgGameData.lanes.reduce(function(max, lane) {
          return Math.max(max, lane.enemies.reduce(function(sum, enemy) {
            return sum + enemy.dps;
          }, 0));
        }, 0);
        cache = maxHp / (enemyDps || s().m_rgGameData.level * 4);
      }
      return cache;
    };
  })();

  function updateNext() {
    next = necessaryUpgrade();
    if (next.id === -1) {
      if (timeToDie() < survivalTime) {
        next = bestHealthUpgrade();
      } else {
        var damage = bestDamageUpgrade();
        var ability = nextAbilityUpgrade();
        next = (damage.cost < ability.cost || ability.id === -1) ? damage : ability;
      }
    }
    if (next.id !== -1) {
      console.log(
        'next buy:',
        s().m_rgTuningData.upgrades[next.id].name,
        '(' + FormatNumberForDisplay(next.cost) + ')'
      );
    }
  };

  function setPreference(key, value) {
    // From wchill
    try {
      if (localStorage !== 'undefined') {
        localStorage.setItem('steamdb-minigame/' + key, value);
      }
    } catch (e) {
      console.log(e); // silently ignore error
    }
  }

  function getPreference(key, defaultValue) {
    // From wchill
    try {
      if (localStorage !== 'undefined') {
        var result = localStorage.getItem('steamdb-minigame/' + key);
        return (result !== null ? result : defaultValue);
      }
    } catch (e) {
      console.log(e); // silently ignore error
      return defaultValue;
    }
  }

  function getPreferenceBoolean(key, defaultValue) {
    // From wchill
    return (getPreference(key, defaultValue.toString()) == "true");
  }

  function makeCheckBox(name, desc, state, listener) {
    // Taken from wchill script
    var label= document.createElement("label");
    var description = document.createTextNode(desc);
    var checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.name = name;
    checkbox.checked = state;
    checkbox.onclick = listener;

    label.appendChild(checkbox);
    label.appendChild(description);
    label.appendChild(document.createElement("br"));
    return label;
  }

  function handleCheckBox(event) {
    var checkbox = event.target;
    setPreference(checkbox.name, checkbox.checked);
    
    w[checkbox.name] = checkbox.checked;
    return checkbox.checked;
  }

  function toggleEnableBuyAbilities(event) {
    if (event !== undefined) {
      value = handleCheckBox(event);
    }
    if (value) {
      enableBuyAbilities = true;
    } else {
      enableBuyAbilities = false;
    }
  }

  function toggleAutoUpgrades(event) {
    if (event !== undefined) {
      value = handleCheckBox(event);
    }
    if (value) {
      enableAutoUpgradeBuying = true;
      upgradeManager();
    } else {
      enableAutoUpgradeBuying = false;
    }
  }

  (function createInfoBox() {
    if (document.querySelector(".next_upgrade_span")) return;

    // Taken from wchill script because it looks nice
    var options_box = document.querySelector(".game_options");

    next_box = document.createElement('div');
    
    next_box.innerHTML = '<b>Next upgrade to buy:</b><br/><span class="next_upgrade_span"></span><br/>';

    // reset the CSS for the info box for aesthetics
    next_box.className = "options_box";
    next_box.style.backgroundColor = "#000000";
    next_box.style.width = "600px";
    next_box.style.top = "73px";
    next_box.style.right = "0";
    next_box.style.padding = "12px";
    next_box.style.position = "absolute";
    next_box.style.boxShadow = "2px 2px 0 rgba( 0, 0, 0, 0.6 )";
    next_box.style.color = "#ededed";

    next_box.appendChild(makeCheckBox("enableBuyAbilities", "Enable buying abilities", enableBuyAbilities, toggleEnableBuyAbilities));
    next_box.appendChild(makeCheckBox("enableAutoUpgradeBuying", "Enable automatic upgrade purchases", enableAutoUpgradeBuying, toggleAutoUpgrades));

    options_box.appendChild(next_box);
    
  })();

  function displayNext() {
    next_span = document.querySelector(".next_upgrade_span");

    next_span.innerHTML = s().m_rgTuningData.upgrades[next.id].name + 
      ' (' + FormatNumberForDisplay(next.cost) + ')';
  };

  function hook(base, method, func) {
    var original = method + '_upgradeManager';
    if (!base.prototype[original]) base.prototype[original] = base.prototype[method];
    base.prototype[method] = function() {
      this[original].apply(this, arguments);
      func.apply(this, arguments);
    };
  };

  /********
   * MAIN *
   ********/
  hook(CSceneGame, 'TryUpgrade', function() {
    // if it's a valid try, we should reevaluate after the update
    if (this.m_bUpgradesBusy) next.id = -1;
  });
  
  hook(CSceneGame, 'ChangeLevel', function() {
    // recalculate enemy DPS to see if we can survive this level
    if (timeToDie(true) < survivalTime) updateNext();
  });

  upgradeManagerPrefilter = function(opts, origOpts, xhr) {
    if (opts.url.match(/ChooseUpgrade/)) {
      xhr
      .success(function() {
        // wait as short a delay as possible
        // then we re-run to figure out the next item to queue
        w.setTimeout(upgradeManager, 0);
       })
      .fail(function() {
        // we're desynced. wait til data refresh
        // m_bUpgradesBusy was not set to false
        s().m_bNeedTechTree = true;
        waitingForUpdate = true;
      });
    } else if (opts.url.match(/GetPlayerData/)) {
      if (waitingForUpdate) {
        xhr.success(function(result) {
          var message = g_Server.m_protobuf_GetPlayerDataResponse.decode(result).toRaw(true, true);
          if (message.tech_tree) {
            // done waiting! no longer busy
            waitingForUpdate = false;
            s().m_bUpgradesBusy = false;
          }
        });
      }
    }
  };

  return function() {
    // tried to buy upgrade and waiting for reply; don't do anything
    if (s().m_bUpgradesBusy) return;
    
    // no item queued; refresh stats and queue next item
    if (next.id === -1) {
      getElementals(true);
      timeToDie(true);
      updateNext();
    }
    
    // item queued; buy if we can afford it
    if (next.id !== -1) {
      displayNext();
      if (enableAutoUpgradeBuying && next.cost <= s().m_rgPlayerData.gold) {
        $J('.link').each(function() {
          if ($J(this).data('type') === next.id) {
            s().TryUpgrade(this);
            return false;
          }
        });
      }
    }
  };
})();

if (upgradeManagerTimer) w.clearTimeout(upgradeManagerTimer);
var upgradeManagerTimer = w.setInterval(upgradeManager, 5000);

}(window));
