import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FigmaService } from "./services/figma";
import express, { Request, Response } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { IncomingMessage, ServerResponse } from "http";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export class FigmaMcpServer {
  private readonly server: McpServer;
  private readonly figmaService: FigmaService;
  private sseTransport: SSEServerTransport | null = null;

  constructor(figmaApiKey: string) {
    this.figmaService = new FigmaService(figmaApiKey);
    this.server = new McpServer({
      name: "Figma MCP Server",
      version: "0.1.4",
    });

    this.registerTools();
  }

  private registerTools(): void {
    this.server.tool(
      "get_image", 
      "Get the icon file, Get images from Figma data based on the imageRef of image nodes",
      {
        fileKey: z.string().describe("The key of the Figma file containing the node"),
        nodeId: z.string().describe("The ID of the node to fetch"),
        fileName: z.string().describe("The name of the file to fetch"),
        localPath: z.string().describe("The absolute path to the directory where images are stored in the project"),
      },
      async ({ fileKey, nodeId, fileName, localPath }) => {
        try {
          console.log(
            `get image: ${nodeId} from file: ${fileKey}`,
          );
          const saveSuccess = await this.figmaService.getImage(fileKey, nodeId, fileName, localPath);
          return {
            content: [{ type: "text", text: saveSuccess ? "Success" : "Failed" }],
          };
        } catch (error) {
          console.error(`Error download node ${nodeId} from file ${fileKey}:`, error);
          return {
            content: [{ type: "text", text: `Error fetching node: ${error}` }],
          };
        }
      },
    );

    // Tool to get node information
    this.server.tool(
      "get_node",
      "Get layout information about a specific node in a Figma file",
      {
        fileKey: z.string().describe("The key of the Figma file containing the node"),
        nodeId: z.string().describe("The ID of the node to fetch"),
      },
      async ({ fileKey, nodeId }) => {
        try {
          console.log(
            `Fetching node: ${nodeId} from file: ${fileKey} )`,
          );
          const node = await this.figmaService.getNode(fileKey, nodeId);
          console.log(
            `Successfully fetched node: ${node.name} (ids: ${Object.keys(node.nodes).join(", ")})`,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(node, null, 2) }],
          };
        } catch (error) {
          console.error(`Error fetching node ${nodeId} from file ${fileKey}:`, error);
          return {
            content: [{ type: "text", text: `Error fetching node: ${error}` }],
          };
        }
      },
    );
  }

  async connect(transport: Transport): Promise<void> {
    console.log("Connecting to transport...");
    await this.server.connect(transport);
    console.log("Server connected and ready to process requests");
  }

  async startHttpServer(port: number): Promise<void> {
    const app = express();

    app.get("/sse", async (req: Request, res: Response) => {
      console.log("New SSE connection established");
      this.sseTransport = new SSEServerTransport(
        "/messages",
        res as unknown as ServerResponse<IncomingMessage>,
      );
      await this.server.connect(this.sseTransport);
    });

    app.post("/messages", async (req: Request, res: Response) => {
      if (!this.sseTransport) {
        // @ts-expect-error Not sure why Express types aren't working
        res.sendStatus(400);
        return;
      }
      await this.sseTransport.handlePostMessage(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse<IncomingMessage>,
      );
    });

    app.listen(port, () => {
      console.log(`HTTP server listening on port ${port}`);
      console.log(`SSE endpoint available at http://localhost:${port}/sse`);
      console.log(`Message endpoint available at http://localhost:${port}/messages`);
    });
  }
}
