import { z } from "zod";
import { getConfig } from "../services/config";

const config = getConfig();

const envScheme = z.object({
  YNAB_API_KEY: z
    .string()
    .optional()
    .transform((str) => str || config.ynabApiKey),
  YNAB_BUDGET_ID: z
    .string()
    .optional()
    .transform((str) => str || config.ynabBudgetId),
  YNAB_CATEGORY_GROUPS: z
    .string()
    .optional()
    .transform((str) => {
      if (str) return str.split(",").filter(Boolean);
      return config.ynabCategoryGroups;
    }),
  APP_PORT: z
    .string()
    .optional()
    .transform((str) => (str && parseInt(str)) || config.appPort || 3000),
  APP_API_KEY: z
    .string()
    .optional()
    .transform((str) => str || config.appApiKey),
  APP_API_SECRET: z
    .string()
    .optional()
    .transform((str) => str || config.appApiSecret),
  MAX_FILE_SIZE: z
    .string()
    .optional()
    // Default file size is 5MB
    .transform((str) => (str && parseInt(str)) || 5242880),
});

const env = envScheme.parse(process.env);

export default env;
