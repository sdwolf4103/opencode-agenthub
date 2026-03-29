#!/usr/bin/env node

import { installAgentHubHome } from "./bootstrap.js";

const targetRoot = await installAgentHubHome();
process.stdout.write(`${targetRoot}\n`);
