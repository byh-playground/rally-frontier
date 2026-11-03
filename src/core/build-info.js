// Build marker shared by diagnostics and the protocol handshake.
import { BuildMetadata } from './build-metadata.js';

// Keep the source/protocol marker stable; diagnostics read the separately served deployment record.
const BUILD_ID="development";
const BUILD_META=BuildMetadata;

export { BUILD_ID, BUILD_META };
