// lib/image-generation.js: image generation on the computer running
// Closedhand, with nothing sent anywhere (Settings, "Image generation").
//
// A computer that can run the model turns it on there: a Mac with Apple
// silicon and enough memory, whose graphics are in the chip, or a computer
// whose NVIDIA graphics card Docker hands to Closedhand (docker-compose.gpu.yml,
// added by install.sh). The model (FLUX.2 Klein 4B, Apache 2.0, with its
// Qwen3 4B text model and its decoder), and on a Mac the program
// (stable-diffusion.cpp, MIT; Docker's GPU image has it built in, for CUDA),
// are then fetched in the background, each pinned to a release and checked
// against its checksum (lib/model-files.js), and kept beside the other local
// models. When they are ready Closedhand says so once in chat, and from then
// on makes a picture from a description (the generate_image tool) and sends
// it.
//
// Where this computer can't make a picture, or hasn't the model yet, a person
// whose plan for the uncensored LLM closedhand.com provides holds gets one
// from the same model in NEAR AI's TEE, through the same private path as
// their chat (lib/near-private.js image): the description is encrypted to
// the enclave, and the picture comes back encrypted to Closedhand and signed.
// It counts toward the plan's fair use like a reply.
//
// What the dashboard shows (on, downloading and how far, ready, or what the
// computer would need) is kept with the other local models' status, under
// "images", which the web app reads.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// Generating holds the model beside everything else running. On a Mac, 8 GB
// works at a smaller size (on an 8 GB M2, a 512 picture in 78 s) and 16 GB
// takes 1024. A graphics card holds it in its own memory.
const MIN_MAC_GB = 8;
const FULL_SIZE_GB = 16;
const MIN_GPU_GB = 8;
const FULL_SIZE_GPU_GB = 12;
// Built into Docker's GPU image (Dockerfile.gpu), for CUDA.
const BUILT_IN = "/opt/stable-diffusion/sd-cli";
const onMac = () => process.platform === "darwin";

const DIR = () => path.join(require("./local-models").MODELS_DIR, "image-generation");
const PROGRAM = {
  repo: "stable-diffusion.cpp/master-1043-3be2378",
  files: [{
    path: "sd.zip", size: 37650853, sha256: "ec40c7b84d86333ea89a9a52745fce25c3081122f6207a4370f35b504df99252",
    url: "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1043-3be2378/sd-master-3be2378-bin-Darwin-macOS-26.6.2-arm64.zip",
  }],
};
const MODEL = {
  repo: "leejet/FLUX.2-klein-4B-GGUF", revision: "3b1f5a9dc3abb32238b053aeb3d823c30afdacbd",
  files: [{ path: "flux-2-klein-4b-Q4_0.gguf", size: 2460378560, sha256: "d1023499ef3f2f82ff7c50e6778495195c1b6cc34835741778868428111f9ff4" }],
};
const TEXT_MODEL = {
  repo: "unsloth/Qwen3-4B-GGUF", revision: "22c9fc8a8c7700b76a1789366280a6a5a1ad1120",
  files: [{ path: "Qwen3-4B-Q4_K_M.gguf", size: 2497281312, sha256: "f6f851777709861056efcdad3af01da38b31223a3ba26e61a4f8bf3a2195813a" }],
};
const DECODER = {
  repo: "black-forest-labs/FLUX.2-klein-4B", revision: "e7b7dc27f91deacad38e78976d1f2b499d76a294",
  files: [{ path: "vae/diffusion_pytorch_model.safetensors", size: 168120878, sha256: "ca70d2202afe6415bdbcb8793ba8cd99fd159cfe6192381504d6c4d3036e0f04" }],
};
const PARTS = [PROGRAM, MODEL, TEXT_MODEL, DECODER];
// What is fetched here: the program only on a Mac.
const parts = () => (onMac() ? PARTS : PARTS.slice(1));
const bytesOf = (list) => list.reduce((n, p) => n + p.files.reduce((m, f) => m + f.size, 0), 0);
const TOTAL_BYTES = bytesOf(PARTS);
const where = (part, file = part.files[0]) => path.join(DIR(), part.repo, file.path);
const program = () => (onMac() ? path.join(path.dirname(where(PROGRAM)), "bin", "sd-cli") : BUILT_IN);

// The NVIDIA card Docker handed in, if any: its name and memory.
let _gpu = null;
function detectGpu() {
  return new Promise((resolve) => execFile("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { timeout: 10000 }, (e, out) => {
    if (e) return resolve(null);
    const [name, mib] = String(out).split("\n")[0].split(",").map((x) => x.trim());
    resolve(name && Number(mib) ? { name, vramGb: Number(mib) / 1024 } : null);
  }));
}

// Whether this computer can generate images, and if not, what it would need,
// in words the dashboard shows beside the greyed-out switch.
function eligibility({ platform = process.platform, arch = process.arch, memoryGb = os.totalmem() / 2 ** 30, gpu = _gpu, builtIn = fs.existsSync(BUILT_IN) } = {}) {
  const needs = `Image generation needs a Mac with Apple silicon and ${MIN_MAC_GB} GB of memory or more, or an NVIDIA graphics card with ${MIN_GPU_GB} GB or more.`;
  if (platform === "darwin") {
    if (arch !== "arm64") return { eligible: false, needs };
    if (memoryGb + 0.5 < MIN_MAC_GB) return { eligible: false, needs: `${needs} This Mac has ${Math.round(memoryGb)} GB.` };
    return { eligible: true, needs: null };
  }
  if (!gpu || !builtIn) return { eligible: false, needs };
  if (gpu.vramGb + 0.5 < MIN_GPU_GB) return { eligible: false, needs: `${needs} This computer's ${gpu.name} has ${Math.round(gpu.vramGb)} GB.` };
  return { eligible: true, needs: null };
}

let _status = null;
async function readStatus() {
  const all = (await require("./config").getConf("LOCAL_MODELS_STATUS")) || {};
  return (all && all.images) || {};
}
async function writeStatus(patch) {
  const { getConf, setConf } = require("./config");
  const all = (await getConf("LOCAL_MODELS_STATUS")) || {};
  _status = { ...((all && all.images) || {}), ...patch, updated_at: new Date().toISOString() };
  await setConf({ LOCAL_MODELS_STATUS: { ...all, images: _status } });
  return _status;
}
function ready() { return !!_status && _status.state === "ready"; }

// Why a picture can't be made here right now, in words for the person, or
// null when it can. Asked for one without this, Closedhand once made it
// through a free website instead, sending the description to a company
// nobody chose and sending back its watermark.
function unavailable(status = _status || {}) {
  if (status.state === "ready") return null;
  if (status.eligible === false) return status.needs || "Image generation can't run on the computer running Closedhand.";
  if (status.state === "downloading") return `Image generation is still downloading on the computer running Closedhand${Number.isFinite(status.pct) ? ` (${status.pct}%)` : ""}.`;
  return "Image generation is off. It can be turned on in Settings, under Image generation, which downloads the model once.";
}

// Everything on disk, the program unpacked.
function present() {
  const { missing } = require("./model-files");
  return parts().every((p) => !missing(DIR(), p, p.files).length) && fs.existsSync(program());
}

// At start: what this computer can do, whether it is ready, and a download
// that was under way when it stopped carries on.
async function boot() {
  if (!onMac()) _gpu = await detectGpu();
  const can = eligibility();
  const was = await readStatus();
  const state = !can.eligible ? "off" : present() ? "ready" : was.wanted ? "downloading" : "off";
  await writeStatus({ ...can, total_gb: Math.round(bytesOf(parts()) / 1e9 * 10) / 10, state, wanted: can.eligible && !!was.wanted });
  if (state === "downloading") turnOn().catch(() => {});
}

let _fetching = null;
// Turned on: everything fetched in the background, with how far it has got.
function turnOn() {
  if (_fetching) return _fetching;
  _fetching = (async () => {
    if (!eligibility().eligible) throw new Error(eligibility().needs);
    const { ensureFiles, missing } = require("./model-files");
    await writeStatus({ state: "downloading", wanted: true, pct: 0, error: null });
    // How far, across every file: those already here count as done.
    const total = bytesOf(parts());
    let done = total - parts().reduce((n, p) => n + missing(DIR(), p, p.files).reduce((m, f) => m + f.size, 0), 0);
    let shown = -1;
    try {
      // Each part is one file.
      for (const part of parts()) {
        const todo = missing(DIR(), part, part.files);
        await ensureFiles(DIR(), part, part.files, ({ loaded }) => {
          const pct = Math.min(99, Math.floor(((done + loaded) / total) * 100));
          if (pct !== shown) { shown = pct; writeStatus({ pct }).catch(() => {}); }
        });
        done += todo.reduce((m, f) => m + f.size, 0);
      }
      await unpackProgram();
      await writeStatus({ state: "ready", pct: 100, error: null });
      await tellReady().catch((e) => console.error("[images] could not say it is ready:", e.message));
    } catch (e) {
      await writeStatus({ state: "error", error: String(e.message || e).slice(0, 200) });
      throw e;
    } finally { _fetching = null; }
  })();
  return _fetching;
}

// On a Mac the program comes as a zip: unpacked once beside it.
function unpackProgram() {
  if (!onMac()) return Promise.resolve();
  const zip = where(PROGRAM);
  const bin = path.join(path.dirname(zip), "bin");
  if (fs.existsSync(path.join(bin, "sd-cli"))) return Promise.resolve();
  return new Promise((resolve, reject) => execFile("/usr/bin/ditto", ["-x", "-k", zip, bin], (e) => (e ? reject(e) : resolve())));
}

// Turned off: what was fetched is removed, freeing its space.
async function turnOff() {
  fs.rmSync(DIR(), { recursive: true, force: true });
  return writeStatus({ state: "off", wanted: false, pct: 0, error: null });
}

// Said once, in chat, when the model is ready.
async function tellReady() {
  const userId = await require("./admin").ensureAdmin();
  const { UserStore } = require("../user-store");
  const store = await UserStore.load(userId);
  const { supabase } = require("./db");
  const { data: links } = await supabase.from("chat_links").select("platform, platform_user_id").eq("user_id", userId);
  await require("./proactive").deliverUnprompted(userId, store, links || [], async () =>
    "Image generation is ready. I generate images right here on this computer, with nothing sent anywhere: describe one and I'll make it.");
}

// A picture's size by its shape, at full size where the computer has the
// memory for it and half that where it has less: a Mac's memory, or a
// graphics card's own.
const SHAPES = { square: [1024, 1024], portrait: [768, 1024], landscape: [1024, 768] };
function sizeFor(shape, memoryGb = _gpu ? _gpu.vramGb : os.totalmem() / 2 ** 30, fullAt = _gpu ? FULL_SIZE_GPU_GB : FULL_SIZE_GB) {
  const [w, h] = SHAPES[shape] || SHAPES.square;
  return memoryGb + 0.5 < fullAt ? [w / 2, h / 2] : [w, h];
}

// One picture at a time: each takes the computer's graphics and most of its
// spare memory. Resolves to the PNG's bytes.
let _queue = Promise.resolve();
function generate(prompt, { shape = "square", width, height, seed = Math.floor(Math.random() * 2 ** 31) } = {}) {
  if (!width || !height) [width, height] = sizeFor(shape);
  const job = () => new Promise((resolve, reject) => {
    if (!ready()) return reject(new Error("Image generation isn't turned on, or is still downloading."));
    const out = path.join(os.tmpdir(), `closedhand-image-${process.pid}-${Date.now()}.png`);
    const size = (n) => Math.max(256, Math.min(1536, Math.round(Number(n) / 16) * 16 || 1024));
    const args = [
      "--diffusion-model", where(MODEL), "--llm", where(TEXT_MODEL), "--vae", where(DECODER),
      "-p", String(prompt).slice(0, 2000), "-W", String(size(width)), "-H", String(size(height)),
      "--steps", "4", "--cfg-scale", "1.0", "-s", String(seed), "-o", out,
      // The model files mapped, not copied into memory: macOS drops their
      // pages and reads them again rather than writing them to swap (on an
      // 8 GB M2, a 512 picture took 78 s where a copied model swapped hard).
      "--mmap",
    ];
    execFile(program(), args, { timeout: 15 * 60000, maxBuffer: 16 * 1024 * 1024 }, (e) => {
      try {
        if (e) return reject(new Error("The picture couldn't be made: " + String(e.message).split("\n")[0].slice(0, 160)));
        resolve(fs.readFileSync(out));
      } catch (err) { reject(err); } finally { fs.rmSync(out, { force: true }); }
    });
  });
  const run = _queue.then(() => require("./idle").during(job));
  _queue = run.catch(() => {});
  return run;
}

const TEE_MODEL = "black-forest-labs/FLUX.2-klein-4B";
async function inTee(prompt, { shape = "square", apiKey }) {
  const [w, h] = SHAPES[shape] || SHAPES.square;
  const res = await require("./near-private").image({ baseUrl: "https://cloud-api.near.ai/v1", apiKey }, { model: TEE_MODEL, prompt: String(prompt).slice(0, 2000), size: `${w}x${h}` });
  const body = await res.json().catch(() => ({}));
  const b64 = res.ok && body.data?.[0]?.b64_json;
  if (!b64) {
    console.warn(`[images] the TEE made no picture: HTTP ${res.status} ${String(body?.error?.message || "").slice(0, 160)}`);
    throw new Error("The picture couldn't be made just now. Try again in a minute.");
  }
  return Buffer.from(b64, "base64");
}

// A picture for the person, { bytes, name, mime }: made on this computer when
// its model is ready, otherwise in the TEE with their plan. When neither can,
// the error says why (unavailable: true).
async function picture(prompt, { shape, settings } = {}) {
  if (ready()) return { bytes: await generate(prompt, { shape }), name: "image.png", mime: "image/png" };
  if (require("./included-ai").live(settings)) {
    const apiKey = require("./model-policy").openKey(settings.included_api_key);
    return { bytes: await inTee(prompt, { shape, apiKey }), name: "image.jpg", mime: "image/jpeg" };
  }
  // A computer that can't run the model at all, with no plan: the person
  // hears how to get pictures (offerText). One that could, but has it off or
  // still downloading, needs only the reason.
  throw Object.assign(new Error(unavailable()), { unavailable: true, offer: (_status || {}).eligible === false });
}

// What follows the reply when the person asked for a picture this computer
// can't make and has no plan that would: the subscription, or paying ahead
// again after a plan paid ahead, and the one link to it.
function offerText(settings, web) {
  const plan = settings?.included_ai?.plan;
  if (plan?.name === "ended" && plan.was === "ahead") return "Paying ahead again in My Account lets Closedhand make pictures here too, with FLUX.2 Klein in a TEE, so nobody but you can see them.";
  return `With the Closedhand subscription, Closedhand makes pictures here too, with FLUX.2 Klein in a TEE, so nobody but you can see them: ${web ? "[closedhand.com/subscribe](https://closedhand.com/subscribe)" : "closedhand.com/subscribe"}`;
}

// POST /internal/images { on }: the dashboard's switch. Turning on returns at
// once; the download goes on in the background, its progress in the status.
function register(app, deps = {}) {
  const verifyToken = deps.verifyToken || require("./web-chat-ws").verifyToken;
  app.post("/internal/images", async (req, res) => {
    if (!verifyToken(req.get("x-closedhand-token"))) return res.status(401).json({ error: "Not allowed" });
    try {
      if (req.body && req.body.on) {
        const can = eligibility();
        if (!can.eligible) return res.status(409).json({ error: can.needs });
        turnOn().catch((e) => console.error("[images] download failed:", e.message));
        return res.json({ ok: true, state: "downloading" });
      }
      await turnOff();
      res.json({ ok: true, state: "off" });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  boot().catch((e) => console.error("[images] start:", e.message));
}

module.exports = { eligibility, boot, turnOn, turnOff, generate, picture, offerText, sizeFor, ready, unavailable, readStatus, register, present, detectGpu, MIN_MAC_GB, MIN_GPU_GB, TOTAL_BYTES, PARTS, BUILT_IN };
