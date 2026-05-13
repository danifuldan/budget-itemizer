import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { auth } from "../middleware";
import { getConfig, saveConfig } from "../../services/config";
import {
  AVAILABLE_MODELS,
  getModelsStatus,
  isModelDownloaded,
  downloadModel,
  cancelDownload,
  getModelPath,
} from "../../services/model-manager";
import {
  startLlamaServer,
  stopLlamaServer,
  isLlamaServerRunning,
  getLlamaServerEndpoint,
} from "../../services/llama-server";

const models = new Hono();

models.get("/available", async (c) => {
  const status = getModelsStatus();
  const list = AVAILABLE_MODELS.map((m) => {
    const s = status.find((x) => x.id === m.id);
    return { ...m, downloaded: s?.downloaded ?? false };
  });
  return c.json(list, 200);
});

models.get("/status", async (c) => {
  const config = getConfig();
  return c.json({
    embeddedModel: config.embeddedModel,
    modelReady: isModelDownloaded(config.embeddedModel),
    serverRunning: isLlamaServerRunning(),
    serverEndpoint: getLlamaServerEndpoint(),
  }, 200);
});

models.post("/download", auth, async (c) => {
  const { modelId } = await c.req.json<{ modelId: string }>();
  if (!AVAILABLE_MODELS.find((m) => m.id === modelId)) {
    return c.json({ error: "Unknown model" }, 400);
  }

  return streamSSE(c, async (stream) => {
    try {
      await downloadModel(modelId, async (progress) => {
        await stream.writeSSE({ event: "progress", data: JSON.stringify(progress) });
      });
    } catch (err: any) {
      await stream.writeSSE({ event: "error", data: JSON.stringify({ error: err.message }) });
    }
  });
});

models.post("/cancel-download", auth, async (c) => {
  cancelDownload();
  return c.json({ success: true }, 200);
});

models.post("/delete", auth, async (c) => {
  const { modelId } = await c.req.json<{ modelId: string }>();
  const { deleteModel } = await import("../../services/model-manager");
  deleteModel(modelId);
  return c.json({ success: true }, 200);
});

models.post("/activate", auth, async (c) => {
  const { modelId } = await c.req.json<{ modelId: string }>();
  const modelPath = getModelPath(modelId);
  if (!modelPath) {
    return c.json({ error: "Model not downloaded" }, 400);
  }

  try {
    await stopLlamaServer();
    const endpoint = await startLlamaServer(modelPath);
    await saveConfig({ embeddedModel: modelId });
    return c.json({ success: true, endpoint }, 200);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default models;
