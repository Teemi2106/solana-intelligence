import "server-only";
import { cache } from "react";
import { parseConfig } from "@swi/config";

export const getServerConfig = cache(() => parseConfig(process.env));
