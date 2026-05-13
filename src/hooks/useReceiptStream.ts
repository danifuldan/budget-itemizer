import { useRef, useCallback } from "react";
import { streamParse } from "../api/client";
import type { SSEEvent, SSEHeader, SSEItem, SSETotal, SSECategories, SSEDone, SSEError } from "../api/types";
import type { AppAction } from "../App";

export function useReceiptStream(dispatch: React.Dispatch<AppAction>) {
  const controllerRef = useRef<AbortController | null>(null);

  const startStream = useCallback(
    (file: File) => {
      dispatch({ type: "START_STREAM", file });

      const controller = streamParse(
        file,
        (sseEvent: SSEEvent) => {
          switch (sseEvent.event) {
            case "status":
              dispatch({ type: "SET_STATUS", step: sseEvent.data.step });
              break;
            case "header":
              dispatch({ type: "SET_HEADER", header: sseEvent.data as SSEHeader });
              break;
            case "item":
              dispatch({ type: "ADD_ITEM", item: sseEvent.data as SSEItem });
              break;
            case "total":
              dispatch({ type: "SET_TOTAL", totals: sseEvent.data as SSETotal });
              break;
            case "categories":
              dispatch({
                type: "SET_CATEGORIES",
                categories: (sseEvent.data as SSECategories).categories,
              });
              break;
            case "done":
              dispatch({ type: "STREAM_DONE", receipt: (sseEvent.data as SSEDone).receipt });
              break;
            case "error":
              dispatch({
                type: "STREAM_ERROR",
                error: (sseEvent.data as SSEError).message,
              });
              break;
          }
        },
        (error: Error) => {
          dispatch({ type: "STREAM_ERROR", error: error.message });
        }
      );

      controllerRef.current = controller;
    },
    [dispatch]
  );

  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    dispatch({ type: "RESET" });
  }, [dispatch]);

  return { startStream, abort };
}
