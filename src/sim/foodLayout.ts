import type { FoodPatch, SimConfig } from "./config.js";
import { nextUint32 } from "./rng.js";
import { gridScaleOf, scaledFoodPatch } from "./gridScale.js";

/** Food budgets and jitter draws are per original resource cell. Fine terrain
 * subdivides its footprint, never its resources or random draw schedule.
 * The reference-grid food config of a grid-scale-2 config: food placement's own input, never a playable config. */
export function referenceFoodConfig(config: SimConfig): SimConfig {
  const scale = gridScaleOf(config);
  return { ...config, ...{ gridScale: undefined },
    mapWidth: config.mapWidth / scale, mapHeight: config.mapHeight / scale,
    nestTileX: (config.nestTileX + 0.5) / scale - 0.5,
    nestTileY: (config.nestTileY + 0.5) / scale - 0.5,
    foodPatches: config.foodPatches.map(p => scaledFoodPatch(p, 1 / scale)),
    ...(config.foodLayout === undefined ? {} : { foodLayout: {
      ...config.foodLayout, patches: config.foodLayout.patches.map(p => scaledFoodPatch(p, 1 / scale)),
      positionJitterTiles: config.foodLayout.positionJitterTiles / scale,
      radiusJitterTiles: config.foodLayout.radiusJitterTiles / scale,
      nestClearanceTiles: config.foodLayout.nestClearanceTiles / scale,
      patchClearanceTiles: config.foodLayout.patchClearanceTiles / scale,
    } }),
  };
}

/** Configuration/placement failures are safe to contain at the server's start boundary. */
export class FoodLayoutError extends Error {
  override readonly name = "FoodLayoutError";
}

/** One placement seam for open fields and terrain. A false mask cell is impassable.
 * Templates, not previously resolved foodPatches, drive generation: original and
 * resolved log headers therefore replay identically. No simulation RNG is spent.
 */
export function generateFoodLayout(config: SimConfig, seed: number, passable?: readonly boolean[]): readonly FoodPatch[] {
  if (config.foodLayout === undefined) return config.foodPatches;
  const scale = gridScaleOf(config);
  const reference = referenceFoodConfig(config);
  const mask = passable === undefined ? undefined : Array.from(
    { length: reference.mapWidth * reference.mapHeight }, (_, index) => {
      const left = (index % reference.mapWidth) * scale, top = Math.floor(index / reference.mapWidth) * scale;
      for (let y = top; y < top + scale; y++) for (let x = left; x < left + scale; x++) {
        if (!passable[y * config.mapWidth + x]) return false;
      }
      return true;
    });
  return generateReferenceFoodLayout(reference, seed, mask).map(p => scaledFoodPatch(p, scale));
}

/** Seeded placement on the reference grid (referenceFoodConfig's output); a false mask cell is impassable. */
export function generateReferenceFoodLayout(config: SimConfig, seed: number, passable?: readonly boolean[]): readonly FoodPatch[] {
  const rules = config.foodLayout;
  if (rules === undefined) return config.foodPatches;
  const positive = [config.mapWidth, config.mapHeight, rules.placementAttempts, rules.layoutAttempts,
    rules.minStartingFood, rules.maxStartingFood];
  const nonnegative = [config.foodJitter, rules.positionJitterTiles, rules.radiusJitterTiles,
    rules.richnessJitter, rules.nestClearanceTiles, rules.patchClearanceTiles];
  if (positive.some((n) => !Number.isSafeInteger(n) || n <= 0) ||
      nonnegative.some((n) => !Number.isSafeInteger(n) || n < 0) || config.mapWidth % 2 !== 0 ||
      rules.minStartingFood > rules.maxStartingFood || rules.patches.length === 0 ||
      !Number.isSafeInteger(config.nestTileX) || !Number.isSafeInteger(config.nestTileY) ||
      config.nestTileX < 0 || config.nestTileX >= config.mapWidth || config.nestTileY < 0 || config.nestTileY >= config.mapHeight ||
      rules.patches.some((p) => ![p.tileX, p.tileY, p.radius, p.perTile].every(Number.isSafeInteger) || p.radius < 1 || p.perTile < 1) ||
      rules.optionalPatchIndices?.some(i => !Number.isSafeInteger(i) || i < 0 || i >= rules.patches.length)) {
    throw new FoodLayoutError("Invalid seeded food layout configuration");
  }
  if (passable !== undefined && passable.length !== config.mapWidth * config.mapHeight) {
    throw new FoodLayoutError("Food passability mask must have one cell per map tile");
  }
  let rng = seed >>> 0;
  const draw = (low: number, high: number): number => {
    const next = nextUint32(rng);
    rng = next.state;
    return low + next.value % (high - low + 1);
  };
  const mirror = (p: FoodPatch): FoodPatch => ({ ...p, tileX: config.mapWidth - 1 - p.tileX });
  const apart = (a: FoodPatch, b: FoodPatch): boolean =>
    (a.tileX - b.tileX) ** 2 + (a.tileY - b.tileY) ** 2 >= (a.radius + b.radius + rules.patchClearanceTiles) ** 2;
  const nests = [config.nestTileX, config.mapWidth - 1 - config.nestTileX];
  const nearestHomeFoodDistanceSquared = (patch: FoodPatch): number => {
    let nearest = Infinity;
    for (let y = -patch.radius; y <= patch.radius; y++) for (let x = -patch.radius; x <= patch.radius; x++) {
      if (x * x + y * y > patch.radius ** 2) continue;
      nearest = Math.min(nearest, (patch.tileX + x - config.nestTileX) ** 2 +
        (patch.tileY + y - config.nestTileY) ** 2);
    }
    return nearest;
  };
  const valid = (patch: FoodPatch, placed: readonly FoodPatch[], checkWater = true): boolean => {
    if (patch.tileX - patch.radius < 0 || patch.tileX + patch.radius >= config.mapWidth / 2 ||
        patch.tileY - patch.radius < 0 || patch.tileY + patch.radius >= config.mapHeight) return false;
    const other = mirror(patch);
    if (!apart(patch, other) || placed.some((p) => !apart(patch, p) || !apart(patch, mirror(p)))) return false;
    for (const p of [patch, other]) {
      if (nests.some((x) => (p.tileX - x) ** 2 + (p.tileY - config.nestTileY) ** 2 <
        (p.radius + rules.nestClearanceTiles) ** 2)) return false;
      if (checkWater && passable !== undefined) {
        for (let y = p.tileY - p.radius; y <= p.tileY + p.radius; y++) {
          for (let x = p.tileX - p.radius; x <= p.tileX + p.radius; x++) {
            if ((x - p.tileX) ** 2 + (y - p.tileY) ** 2 <= p.radius ** 2 && !passable[y * config.mapWidth + x]) return false;
          }
        }
      }
    }
    return true;
  };
  // Resolve impossible optional pairs before seeded placement, without spending RNG.
  const candidates = rules.patches.map((template) => {
    const side = Math.sign(template.tileY - config.nestTileY);
    const homeDistance = side === 0 ? Infinity : nearestHomeFoodDistanceSquared(template);
    const choices = new Map<string, { patch: FoodPatch; minimum: number; maximum: number }>();
    const add = (patch: FoodPatch): void => {
      if (!valid(patch, [])) return;
      let area = 0;
      for (let y = -patch.radius; y <= patch.radius; y++) for (let x = -patch.radius; x <= patch.radius; x++) {
        if (x * x + y * y <= patch.radius ** 2) area++;
      }
      for (let perTile = Math.max(1, template.perTile - rules.richnessJitter);
        perTile <= template.perTile + rules.richnessJitter; perTile++) {
        const candidate = { ...patch, perTile };
        choices.set(JSON.stringify(candidate), { patch: candidate,
          minimum: 2 * area * Math.max(1, perTile - config.foodJitter),
          maximum: 2 * area * (perTile + config.foodJitter) });
      }
    };
    for (let radius = Math.max(1, template.radius - rules.radiusJitterTiles);
      radius <= template.radius + rules.radiusJitterTiles; radius++) {
      const firstY = side === 0 ? config.nestTileY : template.tileY - rules.positionJitterTiles;
      const lastY = side === 0 ? config.nestTileY : template.tileY + rules.positionJitterTiles;
      for (let tileY = firstY; tileY <= lastY; tileY++) {
        if (Math.sign(tileY - config.nestTileY) !== side) continue;
        for (let tileX = template.tileX - rules.positionJitterTiles;
          tileX <= template.tileX + rules.positionJitterTiles; tileX++) {
          const patch = { tileX, tileY, radius, perTile: template.perTile };
          if (side !== 0 && nearestHomeFoodDistanceSquared(patch) > homeDistance) continue;
          add(patch);
          // Enumerate the same central-bank exception as the random path.
          // Backtracking chooses a bank that also clears the other patches.
          const middle = config.mapWidth / 2;
          if (passable !== undefined && side === 0 && template.tileX > config.mapWidth / 3 &&
              valid(patch, [], false) &&
              !passable[tileY * config.mapWidth + middle - 1] &&
              !passable[tileY * config.mapWidth + middle]) {
            const banks = Array.from({ length: Math.max(0, middle - 2 * radius) }, (_, i) => radius + i)
              .sort((a, b) => Math.abs(a - tileX) - Math.abs(b - tileX) || a - b);
            for (const bank of banks) add({ ...patch, tileX: bank });
          }
        }
      }
    }
    return [...choices.values()];
  });
  // Only explicitly marked new-economy frontline pairs may be omitted. Each
  // entry is a left-half circle: layFood supplies its mirror, so omitting one
  // entry necessarily omits both sides. Unmarked recorded recipes remain strict.
  const optional = new Set(rules.optionalPatchIndices);
  const forcedOmissions = new Array<number>(candidates.length + 1).fill(0);
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (candidates[i]!.length === 0 && !optional.has(i)) {
      throw new FoodLayoutError("Cannot place seeded food patches within configured clearance, passability and food bounds");
    }
    forcedOmissions[i] = forcedOmissions[i + 1]! + (candidates[i]!.length === 0 ? 1 : 0);
  }
  for (let layout = 0; layout < rules.layoutAttempts; layout++) {
    const patches: FoodPatch[] = [];
    let minimum = 0, maximum = 0;
    for (const [index, template] of rules.patches.entries()) {
      if (optional.has(index) && candidates[index]!.length === 0) continue;
      const side = Math.sign(template.tileY - config.nestTileY);
      const homeDistance = side === 0 ? Infinity : nearestHomeFoodDistanceSquared(template);
      let chosen: FoodPatch | undefined;
      for (let attempt = 0; attempt < rules.placementAttempts; attempt++) {
        const tileX = draw(template.tileX - rules.positionJitterTiles, template.tileX + rules.positionJitterTiles);
        const tileY = draw(template.tileY - rules.positionJitterTiles, template.tileY + rules.positionJitterTiles);
        const patch: FoodPatch = {
          tileX,
          // Existing steering distinguishes lane and flank patches by their row.
          // Keep the same draw schedule while preserving the template's role.
          tileY: side === 0 ? config.nestTileY : tileY,
          radius: draw(Math.max(1, template.radius - rules.radiusJitterTiles), template.radius + rules.radiusJitterTiles),
          perTile: draw(Math.max(1, template.perTile - rules.richnessJitter), template.perTile + rules.richnessJitter),
        };
        if (Math.sign(patch.tileY - config.nestTileY) !== side) continue;
        // Preserve the bootstrap flank's reachability without changing sight or steering.
        if (side !== 0 && nearestHomeFoodDistanceSquared(patch) > homeDistance) continue;
        if (valid(patch, patches)) { chosen = patch; break; }
        // The central food keeps its lane role on the nest row. When that
        // row's mirror line itself is water, a neutral move on the line is
        // impossible: retain the two equal circular halves and split them
        // onto opposite dry banks. The implicit mirror in layFood supplies
        // the other half. Never change radius, richness, spacing or RNG draws.
        const middle = config.mapWidth / 2;
        if (passable !== undefined && side === 0 && template.tileX > config.mapWidth / 3 &&
            valid(patch, patches, false) &&
            !passable[patch.tileY * config.mapWidth + middle - 1] &&
            !passable[patch.tileY * config.mapWidth + middle]) {
          let bank: FoodPatch | undefined;
          let nearest = Infinity;
          for (let x = patch.radius; x + patch.radius < middle; x++) {
            const candidate = { ...patch, tileX: x };
            const distance = Math.abs(x - patch.tileX);
            if (valid(candidate, patches) && distance < nearest) { bank = candidate; nearest = distance; }
          }
          if (bank !== undefined) { chosen = bank; break; }
        }
      }
      if (chosen === undefined) break;
      patches.push(chosen);
      let area = 0;
      for (let y = -chosen.radius; y <= chosen.radius; y++) for (let x = -chosen.radius; x <= chosen.radius; x++) {
        if (x * x + y * y <= chosen.radius ** 2) area++;
      }
      minimum += 2 * area * Math.max(1, chosen.perTile - config.foodJitter);
      maximum += 2 * area * (chosen.perTile + config.foodJitter);
    }
    // Conservative bounds include every possible jitter draw, not just this seed.
    if (patches.length === rules.patches.length - forcedOmissions[0]! && minimum >= rules.minStartingFood && maximum <= rules.maxStartingFood) return patches;
  }
  // Random retries are not a proof that the constraints are impossible. Only
  // exhausted seeds reach this deterministic search; keep the successful path
  // and its draw schedule above untouched. No simulation or placement RNG here.
  // Prove a complete layout impossible before dropping a pair, then minimize
  // omissions. The zero-omission search and every successful random path retain
  // the old ordering and draw schedule. Never relax clearance or food bounds.
  for (let omissions = forcedOmissions[0]!; omissions <= optional.size; omissions++) {
    const remainingMinimum = new Array<number>(candidates.length + 1).fill(0);
    const remainingMaximum = new Array<number>(candidates.length + 1).fill(0);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const choices = candidates[i]!;
      remainingMinimum[i] = remainingMinimum[i + 1]! +
        (optional.has(i) && omissions > 0 ? 0 : Math.min(...choices.map(p => p.maximum)));
      remainingMaximum[i] = remainingMaximum[i + 1]! + (choices.length === 0 ? 0 : Math.max(...choices.map(p => p.minimum)));
    }
    const patches: FoodPatch[] = [];
    const search = (index: number, minimum: number, maximum: number, left: number): boolean => {
      if (forcedOmissions[index]! > left || maximum + remainingMinimum[index]! > rules.maxStartingFood ||
          minimum + remainingMaximum[index]! < rules.minStartingFood) return false;
      if (index === candidates.length) return true;
      for (const choice of candidates[index]!) {
        if (!valid(choice.patch, patches, false)) continue;
        patches.push(choice.patch);
        if (search(index + 1, minimum + choice.minimum, maximum + choice.maximum, left)) return true;
        patches.pop();
      }
      return optional.has(index) && left > 0 && search(index + 1, minimum, maximum, left - 1);
    };
    if (search(0, 0, 0, omissions)) return patches;
  }
  throw new FoodLayoutError("Cannot place seeded food patches within configured clearance, passability and food bounds");
}
