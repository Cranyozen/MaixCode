import { Instance } from "../instance";
import { info, warn, error } from "../logger";
import ws from "ws";

const HEADER = Uint8Array.of(172, 190, 203, 202);
const VERSION = Uint8Array.of(0);
const COMMAND = {
  Auth: 1,
  AuthAck: 2,
  Run: 3,
  RunAck: 4,
  Output: 5,
  Img: 6,
  Stop: 7,
  StopAck: 8,
  Finish: 9,
  Msg: 10,
  Heartbeat: 11,
  DeviceInfo: 12,
  DeviceInfoAck: 13,
  ImgFormat: 14,
  ImgFormatAck: 15,
  InstallApp: 16,
  InstallAppAck: 17,
  RunProject: 18,
};

function num2Uint8Array(num: number) {
  const arr = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    arr[i] = num % 256;
    num = Math.floor(num / 256);
  }
  return arr;
}

function packUint32(value: number) {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, value, true);
  return Array.from(new Uint8Array(buffer));
}

export class WebSocketService {
  private ws?: ws.WebSocket;
  private timeOut?: NodeJS.Timeout;
  public deviceInfo?: string;

  constructor(
    public readonly ip: string,
    public readonly port: number = 7899,
    private readonly timeoutMs: number = 10000,
    public hookOpen: () => void = () => {},
    public hookClose: (code: number, reason: string) => void = () => {},
    public hookError: (
      err: Error | { code: number; msg: string }
    ) => void = () => {},
    public hookImg: (data: ArrayBuffer) => void = () => {}
  ) {}

  public connect() {
    this.ws = new ws.WebSocket(`ws://${this.ip}:${this.port}`);
    this.ws.binaryType = "arraybuffer";

    this.ws.on("open", () => this.onOpen());
    this.ws.on("message", (data) => this.onMessage(data as ArrayBuffer));
    this.ws.on("close", (code, reason) =>
      this.onClose(code, reason.toString())
    );
    this.ws.on("error", (err) => this.onError(err));
    this.heartbeat();
  }

  public disconnect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.onClose(-1, "Disconnect by websocket service");
    }
  }

  private heartbeat() {
    if (this.timeOut) {
      clearTimeout(this.timeOut);
    }
    this.timeOut = setTimeout(() => {
      this.hookError({ code: -1, msg: "Heartbeat timeout" });
      this.disconnect();
    }, this.timeoutMs);
  }

  static packMessage(cmd: number, data: number | string | Buffer) {
    if (typeof data === "number") {
      data = Buffer.from(num2Uint8Array(data));
    } else if (typeof data === "string") {
      data = Buffer.from(data);
    }
    const frameData = new Uint8Array([...VERSION, cmd, ...data]);
    const message = new Uint8Array([
      ...HEADER,
      ...packUint32(frameData.length + 1),
      ...frameData,
    ]);
    const checksum = message.reduce((a, b) => a + b, 0) % 256;
    return new Uint8Array([...message, checksum]);
  }
  private sendMessage(cmd: number, data: number | string | Buffer) {
    if (!this.ws) {
      warn("WebSocket is not connected");
      return;
    }
    info(`Send message: cmd: ${cmd}, data: ${data}`);
    this.ws.send(WebSocketService.packMessage(cmd, data));
    this.heartbeat();
  }
  private onOpen() {
    this.sendMessage(COMMAND.Auth, "maixvision");
    this.hookOpen();
    this.heartbeat();
  }
  private onMessage(message: ArrayBuffer) {
    const result = this.unpackMessage(message);
    if (result) {
      this.handleCommand(result.cmd, result.content);
      this.heartbeat();
    }
  }
  private onError(err: Error) {
    error(err);
    this.hookError(err);
  }
  private onClose(code: number, reason: string) {
    if (this.timeOut) {
      clearTimeout(this.timeOut);
    }
    this.hookClose(code, reason);
  }
  private unpackMessage(
    message: ArrayBuffer,
    wishCmd?: number
  ): { cmd: number; content: Uint8Array } | undefined {
    const data = new Uint8Array(message);
    const header = data.slice(0, 4);
    if (!header.every((value, index) => value === HEADER[index])) {
      error("Invalid header");
      return;
    }
    const dataLen = data
      .slice(4, 8)
      .reduce((acc, value, index) => acc + (value << (index * 8)), 0);
    if (data.length - 8 < dataLen) {
      error("Invalid data length");
      return;
    }
    if (
      data.slice(0, -1).reduce((acc, value) => acc + value, 0) % 256 !==
      data[dataLen + 7]
    ) {
      error("Invalid checksum");
      return;
    }
    const cmd = data[9];
    if (wishCmd && cmd !== wishCmd) {
      error(`Invalid command: ${cmd}`);
      return;
    }
    const content = data.slice(10, 10 + dataLen - 3);
    return { cmd, content };
  }
  private handleCommand(cmd: number, content: Uint8Array) {
    info(`Receive message: cmd: ${cmd}, content: ${content}`);
    let table: { [key: number]: (content: Uint8Array) => void } = {
      [COMMAND.AuthAck]: this.authAckCommand,
      [COMMAND.RunAck]: this.runAckCommand,
      [COMMAND.Output]: this.outputCommand,
      [COMMAND.Img]: this.imgCommand,
      [COMMAND.StopAck]: this.stopAckCommand,
      [COMMAND.Finish]: this.finishCommand,
      [COMMAND.Msg]: this.msgCommand,
      [COMMAND.Heartbeat]: () => this.sendMessage(COMMAND.Heartbeat, ""),
      [COMMAND.DeviceInfoAck]: this.deviceInfoAckCommand,
      [COMMAND.ImgFormatAck]: this.imgFormatCommand,
      [COMMAND.InstallAppAck]: this.installAppAckCommand,
    };
    let handler = table[cmd];
    if (handler) {
      handler.call(this, content);
    } else {
      warn(`Unknown command: cmd: ${cmd}, content: ${content}`);
    }
  }
  private authAckCommand(content: Uint8Array) {
    const isSuccess = content[0] === 1;
    if (isSuccess) {
      info("Connect device successful");
      this.sendMessage(COMMAND.DeviceInfo, "");
    } else {
      const msg = `Connect device failed: ${Buffer.from(
        content.slice(1)
      ).toString()}`;
      this.disconnect();
      error(msg);
      this.hookError({ code: -2, msg });
    }
    return isSuccess;
  }
  private runAckCommand(content: Uint8Array) {
    const isSuccess = content[0] === 1;
    if (isSuccess) {
      info("Start running...");
    } else {
      const msg = `Device execute code failed: ${Buffer.from(
        content.slice(1)
      )}`;
      error(msg);
      this.hookError({ code: -1, msg });
    }
  }
  private outputCommand(content: Uint8Array) {
    const data = Buffer.from(content).toString();
  }
  private imgCommand(content: Uint8Array) {
    this.hookImg(content.slice(1));
    // sharp(content.slice(1))
    //   .raw()
    //   .ensureAlpha()
    //   .toBuffer({ resolveWithObject: true })
    //   .then(({ data, info }) => {
    //     const rsp = {
    //       data: data.buffer,
    //       type: content[0] === 1 ? "jpeg" : "png",
    //       width: info.width,
    //       height: info.height,
    //     };
    //   });
  }
  private stopAckCommand(content: Uint8Array) {
    const isSuccess = content[0] === 1;
    const rsp = isSuccess
      ? { code: 0, msg: "Stop running success" }
      : {
          code: -1,
          msg: `Stop running failed: ${Buffer.from(
            content.slice(1)
          ).toString()}`,
        };
  }
  private finishCommand(content: Uint8Array) {
    const isSuccess = content.slice(0, 4).every((a) => a === 0);
    let rsp;
    if (isSuccess) {
      rsp = { code: 0, msg: "Program exited" };
    } else {
      const view = new DataView(content.slice(0, 4).buffer, 0);
      const code = view.getUint32(0, true);
      const err = Buffer.from(content.slice(4)).toString();
      const msg2 = `Program exit failed. Exit code: ${code}. ${
        err ? "Msg: " + err : ""
      }`;
      rsp = { code, msg: msg2 };
    }
  }
  private msgCommand(content: Uint8Array) {
    return Buffer.from(content).toString();
  }
  private deviceInfoAckCommand(content: Uint8Array) {
    // return Buffer.from(content).toString();
    // decode string to object(json)
    this.deviceInfo = Buffer.from(content).toString();
    Instance.instance.siderbar.refresh();
  }
  private imgFormatCommand(content: Uint8Array) {
    const isSuccess = content[0] === 1;
    const rsp = isSuccess
      ? {
          code: 0,
          format: content[1] === 1 ? "JPEG" : content[1] === 2 ? "PNG" : "",
          msg: "Success",
        }
      : {
          code: -1,
          format: "",
          msg: Buffer.from(content.slice(2)).toString(),
        };
  }
  private installAppAckCommand(content: Uint8Array) {
    const isSuccess = content[1] === 0;
    const rsp = isSuccess
      ? {
          code: 0,
          progress: content[0],
          msg: "Success",
        }
      : {
          code: -1,
          progress: 0,
          msg: Buffer.from(content.slice(2)).toString(),
        };
  }
}
