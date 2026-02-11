/**
 * Type declarations for vscode-jsonrpc/node which isn't exported properly for ESM
 */
declare module "vscode-jsonrpc/node" {
	import type { MessageReader, MessageWriter } from "vscode-languageserver-protocol";

	export class StreamMessageReader implements MessageReader {
		constructor(readable: NodeJS.ReadableStream, encoding?: string);
		onError: any;
		onClose: any;
		onPartialMessage: any;
		listen(callback: (message: any) => void): { dispose: () => void };
		dispose(): void;
	}

	export class StreamMessageWriter implements MessageWriter {
		constructor(writable: NodeJS.WritableStream, options?: string);
		onError: any;
		onClose: any;
		write(msg: any): Promise<void>;
		end(): void;
		dispose(): void;
	}
}
