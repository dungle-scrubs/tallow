import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
	DELTA_CLASSIFICATIONS,
	FORK_KEEP_SET,
	UPSTREAM_REFERENCE_VERSION,
} from "../scripts/audit-pi-tui-fork.mjs";

const repoRoot = process.cwd();
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

const readme = read("packages/tallow-tui/README.md");
const agents = read("AGENTS.md");

assert(
	readme.includes(`@mariozechner/pi-tui@${UPSTREAM_REFERENCE_VERSION}`),
	"fork README must reference current upstream audit version"
);
assert(!readme.includes("v0.52.9"), "fork README must not reference stale v0.52.9 baseline");
assert(
	!readme.includes("Input middleware"),
	"fork README must not claim input middleware as current rationale"
);
assert(
	agents.includes("node scripts/audit-pi-tui-fork.mjs"),
	"AGENTS.md must point to the fork audit script"
);

for (const item of FORK_KEEP_SET) {
	assert(readme.includes(item), `fork README missing keep-set item: ${item}`);
	agents.includes(item) || assert(false, `AGENTS.md missing keep-set item: ${item}`);
}

const requiredClassifications = [
	"border-styles.js",
	"components/editor.js",
	"components/loader.js",
	"terminal.js",
	"tui.js",
	"utils.js",
];
for (const file of requiredClassifications) {
	assert(file in DELTA_CLASSIFICATIONS, `missing delta classification for ${file}`);
}

assert(
	DELTA_CLASSIFICATIONS["border-styles.js"].category === "keep",
	"border-styles.js should remain in the keep set"
);
assert(
	DELTA_CLASSIFICATIONS["utils.js"].category === "extract",
	"utils.js should be classified for extraction"
);
assert(
	DELTA_CLASSIFICATIONS["autocomplete.js"].category === "revert",
	"autocomplete.js should be classified for revert"
);

console.log("pi-tui fork audit docs OK");
