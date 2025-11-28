const WebSocket = require('ws');
const readline = require('readline');

// 核心配置（整合所有需求）
const PORT = 2065;
const DEVICE_TIMEOUT = 10000; // 设备超时时间（10秒）
const CLOSE_TIMEOUT = 5000; // 服务器关闭超时（5秒）
const PREPARE_DELAY = 11000; // 11秒准备引导
const DEVICE_CHECK_INTERVAL = 50; // 50ms设备状态检测/广播间隔

// 创建WebSocket服务器实例
const wss = new WebSocket.Server({ port: PORT });

// 设备状态管理（con字段标识是否在线，用于客户端登录界面同步）
let deviceMap = new Map();
for (let i = 1; i <= 6; i++) {
    deviceMap.set(i, {
        deviceId: i,
        vol: 0,
        avg: 0,
        max: 0,
        min: 100,
        con: false, // 初始离线，登录后设为true
        lastUpdate: Date.now()
    });
}

// 全局状态变量
let isTerminated = false; // 监测终止标记
let isServerClosing = false; // 服务器关闭标记
let deviceCheckInterval; // 设备检测定时器
let closeTimeoutTimer; // 关闭超时定时器

// 控制台交互接口（精简日志）
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// 控制台关闭事件处理
rl.on('close', () => {
    if (!isServerClosing) closeServer();
});

// 控制台命令处理
rl.on('line', (input) => {
    if (isServerClosing) return;

    if (input === '') {
        console.log('\n当前设备状态:');
        printDeviceStatus();
        console.log('\n按回车刷新状态 | set 设备ID 音量 | exit退出');
    } else if (input.startsWith('set ')) {
        const parts = input.split(' ');
        if (parts.length === 3) {
            const deviceId = parseInt(parts[1]);
            const vol = parseFloat(parts[2]);
            if (deviceId >= 1 && deviceId <= 6 && !isNaN(vol) && vol >= 0 && vol <= 100) {
                const device = deviceMap.get(deviceId);
                device.vol = vol;
                device.avg = (device.avg + vol) / 2;
                device.max = Math.max(device.max, vol);
                device.min = Math.min(device.min, vol);
                device.con = true; // 手动设置视为在线
                device.lastUpdate = Date.now();
                console.log(`设备${deviceId}音量设为${vol.toFixed(2)}%`);
                broadcast(); // 状态变化，触发广播
            } else {
                console.log('无效命令格式！正确格式：set 设备ID(1-6) 音量值(0-100)');
            }
        }
    } else if (input === 'exit' || input === 'quit') {
        closeServer();
    } else {
        console.log('未知命令！支持：回车查看状态 | set 设备ID 音量 | exit退出');
    }
});

// 1. 先启动设备检测循环（50ms间隔），再执行准备引导
deviceCheckInterval = setInterval(() => {
    if (isServerClosing) return;

    const now = Date.now();
    let statusChanged = false;

    // 仅检测在线设备的超时状态，减少无效计算
    for (let i = 1; i <= 6; i++) {
        const device = deviceMap.get(i);
        if (!device.con) continue; // 离线设备跳过检测

        const previousStatus = device.con;
        // 判定设备是否离线（超过超时时间未更新）
        device.con = (now - device.lastUpdate) < DEVICE_TIMEOUT;

        if (device.con !== previousStatus) {
            statusChanged = true;
            console.log(`设备${i}状态变更：${device.con ? '在线' : '离线'}`);
        }
    }

    // 状态变化时广播（50ms间隔检测，仅变化时发送，减少冗余）
    if (statusChanged) {
        broadcast();
    }
}, DEVICE_CHECK_INTERVAL);

// 2. 11秒准备引导（确保所有设备初始为离线）
console.log('服务器正在准备……');
setTimeout(() => {
    console.log('完成！接下来可以启动客户端');
    console.log(`服务器已启动，端口: ${PORT}`);
    console.log('操作说明：按回车查看状态 | set 设备ID 音量值 | exit退出');
}, PREPARE_DELAY);

// 广播所有设备状态（核心：客户端登录界面需实时获取所有设备在线状态）
function broadcast() {
    if (isServerClosing) return;

    // 组装所有设备的完整状态（含con字段，用于客户端判断是否登录）
    const statusData = Array.from(deviceMap.values());
    const msg = JSON.stringify(statusData);

    // 非阻塞发送，避免队列堆积（适配50ms高频广播）
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg, (err) => {
                if (err && !isServerClosing) console.error('广播失败');
            });
        }
    });
}

// 新增：广播启动监测信号（给所有在线客户端）
function broadcastStartMonitor() {
    if (isServerClosing || isTerminated) return;
    const startSignal = JSON.stringify({ type: 'start_monitor' });
    console.log('管理员设备启动监测，同步触发所有已登录设备启动');
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(startSignal, (err) => {
                if (err && !isServerClosing) console.error('启动信号广播失败');
            });
        }
    });
}

// 处理客户端连接：新连接时立即发送当前所有设备状态（关键：登录界面同步已登录设备）
wss.on('connection', ws => {
    console.log('新客户端连接');
    // 客户端刚连接时，主动推送一次当前所有设备状态，避免状态同步延迟
    broadcast();

    // 处理客户端消息
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());

            // 优先处理服务器关闭信号
            if (data.type === 'terminate_process') {
                handleTerminateProcess(data.deviceId || '未知');
                return;
            }

            if (isServerClosing) return;

            // 处理核心业务消息
            switch (data.type) {
                case 'login':
                    // 客户端登录：标记设备为在线
                    const loginId = parseInt(data.device);
                    if (loginId >= 1 && loginId <= 6) {
                        const device = deviceMap.get(loginId);
                        device.con = true;
                        device.lastUpdate = Date.now();
                        console.log(`设备${loginId}登录成功`);
                        broadcast(); // 广播状态，所有客户端（含其他登录界面）同步
                    }
                    break;

                case 'logout':
                    // 客户端登出：标记设备为离线
                    const logoutId = parseInt(data.deviceId);
                    if (logoutId >= 1 && logoutId <= 6) {
                        const device = deviceMap.get(logoutId);
                        device.con = false;
                        console.log(`设备${logoutId}登出`);
                        broadcast(); // 广播状态，所有客户端同步
                    }
                    break;

                case 'terminate':
                    // 触发监测终止，生成统计数据
                    handleTerminateSignal();
                    break;

                case 'volume':
                    // 更新设备音量数据，状态变化时广播
                    if (updateDevice(data)) broadcast();
                    break;

                // 新增：处理管理员设备的启动监测信号
                case 'start_monitor':
                    const adminDeviceId = parseInt(data.deviceId);
                    // 仅设备1（管理员）启动时，同步触发其他设备
                    if (adminDeviceId === 1) {
                        broadcastStartMonitor();
                    }
                    break;

                default:
                    // 精简日志：忽略未知消息
                    break;
            }
        } catch (e) {
            console.error('消息解析失败');
        }
    });

    // 静默处理连接错误和关闭（精简日志）
    ws.on('error', () => {});
    ws.on('close', () => {
        console.log('客户端断开连接');
        // 无需额外处理，设备超时检测会自动标记离线
    });
});

// 更新设备音量数据（过滤异常值，适配50ms高频更新）
function updateDevice(data) {
    if (!data.deviceId || data.deviceId < 1 || data.deviceId > 6) return false;

    const device = deviceMap.get(data.deviceId);
    const newVol = parseFloat(data.vol);

    // 更新设备数据（接收音量数据即视为在线，刷新lastUpdate）
    device.vol = newVol;
    device.avg = data.avg;
    device.max = Math.max(device.max, newVol);
    device.min = Math.min(device.min, newVol);
    device.con = true;
    device.lastUpdate = Date.now();

    return true;
}

// 处理监测终止信号（生成统计数据）
function handleTerminateSignal() {
    if (isTerminated) return;
    isTerminated = true;
    console.log('监测已终止，正在生成并发送统计数据');

    const statsData = [];
    for (let i = 1; i <= 6; i++) {
        const device = deviceMap.get(i);
        statsData.push({
            deviceId: i,
            max: parseFloat(device.max.toFixed(2)),
            avg: parseFloat(device.avg.toFixed(2)),
            min: parseFloat(device.min.toFixed(2))
        });
    }

    // 向所有在线客户端发送结束统计信号
    const endSignal = JSON.stringify({ type: 'end_statistics', data: statsData });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(endSignal, (err) => {
                if (err && !isServerClosing) console.error('统计数据发送失败');
            });
        }
    });
}

// 处理服务器关闭信号
function handleTerminateProcess(deviceId) {
    if (isServerClosing) return;
    isServerClosing = true;
    console.log(`收到关闭信号（发起设备：${deviceId}），开始关闭服务器`);

    // 清除所有定时器
    clearInterval(deviceCheckInterval);
    clearTimeout(closeTimeoutTimer);

    // 关闭所有在线客户端连接
    const clients = Array.from(wss.clients);
    const closedClients = new Set();

    if (clients.length === 0) {
        closeWebSocketServer();
        return;
    }

    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.close(1000, '服务器正常关闭');

            client.on('close', () => {
                closedClients.add(client);
                checkAllClientsClosed();
            });

            client.on('error', () => {
                closedClients.add(client);
                checkAllClientsClosed();
            });
        } else {
            closedClients.add(client);
            checkAllClientsClosed();
        }
    });

    // 超时兜底：5秒未关闭则强制退出
    closeTimeoutTimer = setTimeout(() => {
        console.warn(`关闭超时（${CLOSE_TIMEOUT}ms），强制退出`);
        forceExit();
    }, CLOSE_TIMEOUT);

    function checkAllClientsClosed() {
        if (closedClients.size === clients.length) {
            console.log('所有客户端连接已关闭');
            closeWebSocketServer();
        }
    }
}

// 关闭WebSocket服务器
function closeWebSocketServer() {
    wss.close((err) => {
        if (err) {
            console.error('服务器关闭失败');
            forceExit();
        } else {
            console.log('WebSocket服务器已成功关闭');
            closeReadline();
        }
    });

    wss.on('close', () => {
        console.log('WebSocket服务器关闭事件触发');
        closeReadline();
    });
}

// 关闭控制台交互
function closeReadline() {
    if (!rl.closed) {
        rl.close();
    } else {
        forceExit();
    }
}

// 强制退出进程
function forceExit() {
    clearTimeout(closeTimeoutTimer);
    process.exit(0);
}

// 服务器统一关闭入口
function closeServer() {
    if (isServerClosing) return;
    handleTerminateProcess('控制台');
}

// 打印设备状态（控制台查看用）
function printDeviceStatus() {
    console.log('设备ID | 连接状态 | 当前音量 | 平均音量 | 最大音量 | 最小音量');
    console.log('--------------------------------------------------------------');
    for (let i = 1; i <= 6; i++) {
        const device = deviceMap.get(i);
        const status = device.con ? '在线' : '离线';
        console.log(
            `${device.deviceId.toString().padEnd(6)} | ` +
            `${status.padEnd(6)} | ` +
            `${device.vol.toFixed(2).padStart(7)}% | ` +
            `${device.avg.toFixed(2).padStart(7)}% | ` +
            `${device.max.toFixed(2).padStart(7)}% | ` +
            `${device.min.toFixed(2).padStart(7)}%`
        );
    }
}

// 系统信号处理（Ctrl+C终止）
process.on('SIGINT', () => {
    console.log('\n收到系统终止信号（Ctrl+C），正在关闭服务器');
    closeServer();
});

// 未捕获异常处理
process.on('uncaughtException', () => {
    if (isServerClosing) forceExit();
    else closeServer();
});

// 未处理Promise拒绝处理
process.on('unhandledRejection', () => {
    if (isServerClosing) forceExit();
    else closeServer();
});