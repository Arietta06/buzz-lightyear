const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // 允许所有前端跨域连接
    methods: ["GET", "POST"]
  }
});

// 内存中保存所有房间数据
// 结构: { [roomCode]: { hostCode, players: [{id, name}], buzzList: [], canBuzz: false } }
const rooms = {};

io.on('connection', (socket) => {
  console.log(`[Connect] New client connected: ${socket.id}`);

  // 统一广播房间内最新的在线玩家列表
  const updateRoomPlayerList = (roomCode) => {
    const room = rooms[roomCode];
    if (room) {
      // 过滤无效或断联的数据
      const activePlayers = room.players.filter(p => p && p.id);
      io.to(roomCode).emit('player_list_updated', activePlayers);
      console.log(`[Room Update] Room ${roomCode} online players count: ${activePlayers.length}`);
    }
  };

  // 处理玩家离开/断线通用逻辑
  const handleUserLeave = (sock) => {
    const roomCode = sock.roomCode;
    if (roomCode && rooms[roomCode] && sock.isPlayer) {
      const room = rooms[roomCode];
      // 从玩家列表中移除该 socket.id
      room.players = room.players.filter(p => p.id !== sock.id);
      
      // 实时广播更新给 Host
      updateRoomPlayerList(roomCode);
      console.log(`[Player Left] ${sock.playerName || 'A player'} left room ${roomCode}`);
      
      // 重置 Socket 绑定标识
      sock.roomCode = null;
      sock.isPlayer = false;
    }
  };

  // 1. 创建房间 (Host)
  socket.on('create_room', ({ roomCode, hostCode }, callback) => {
    const upperRoom = roomCode.trim().toUpperCase();
    if (rooms[upperRoom]) {
      return callback({ success: false, message: 'Room code already exists!' });
    }

    rooms[upperRoom] = {
      hostCode: hostCode,
      players: [],
      buzzList: [],
      canBuzz: false
    };

    socket.roomCode = upperRoom;
    socket.isHost = true;
    socket.join(upperRoom);

    console.log(`[Room Created] Room: ${upperRoom}`);
    callback({ success: true, roomData: rooms[upperRoom] });
  });

  // 2. Host 重新登录/断线重连
  socket.on('host_login', ({ roomCode, hostCode }, callback) => {
    const upperRoom = roomCode.trim().toUpperCase();
    const room = rooms[upperRoom];

    if (!room) {
      return callback({ success: false, message: 'Room does not exist!' });
    }
    if (room.hostCode !== hostCode) {
      return callback({ success: false, message: 'Incorrect Host passcode!' });
    }

    socket.roomCode = upperRoom;
    socket.isHost = true;
    socket.join(upperRoom);

    console.log(`[Host Relogin] Host joined room: ${upperRoom}`);
    callback({ success: true, roomData: room });
  });

  // 3. 玩家加入房间 (Player)
  socket.on('join_player', ({ roomCode, name }, callback) => {
    const upperRoom = roomCode.trim().toUpperCase();
    const room = rooms[upperRoom];

    if (!room) {
      return callback({ success: false, message: 'Room not found! Check room code.' });
    }

    socket.roomCode = upperRoom;
    socket.isPlayer = true;
    socket.playerName = name.trim();
    socket.join(upperRoom);

    // 检查玩家是否已在列表中，不存在则推入，存在则更新名字
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) {
      room.players.push({ id: socket.id, name: socket.playerName });
    } else {
      room.players[playerIndex].name = socket.playerName;
    }

    console.log(`[Player Joined] ${socket.playerName} joined room ${upperRoom}`);

    // ⚡ 立即广播最新玩家列表
    updateRoomPlayerList(upperRoom);

    callback({ success: true, isCanBuzz: room.canBuzz });
  });

  // 4. 玩家主动点击“EXIT / 退出”
  socket.on('leave_room', () => {
    handleUserLeave(socket);
  });

  // 5. ⚡ 核心离线检测：关闭网页 / 刷新 / 网络断开
  socket.on('disconnecting', () => {
    handleUserLeave(socket);
  });

  socket.on('disconnect', () => {
    console.log(`[Connect Closed] ${socket.id}`);
  });

  // 6. Host 开始新一轮抢答
  socket.on('start_round', () => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];

    if (room && socket.isHost) {
      room.canBuzz = true;
      room.buzzList = []; // 清空上一轮抢答记录

      io.to(roomCode).emit('round_started');
      io.to(roomCode).emit('buzz_update', []);
      console.log(`[Round Started] Room ${roomCode}`);
    }
  });

  // 7. Host 重置/清空当前轮
  socket.on('reset_round', () => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];

    if (room && socket.isHost) {
      room.canBuzz = false;
      room.buzzList = [];

      io.to(roomCode).emit('round_reset');
      console.log(`[Round Reset] Room ${roomCode}`);
    }
  });

  // 8. 玩家按下抢答器
  socket.on('press_buzzer', () => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];

    if (room && room.canBuzz && socket.isPlayer) {
      // 检查该玩家是否已经抢过答
      const alreadyBuzzed = room.buzzList.some(b => b.id === socket.id);
      if (!alreadyBuzzed) {
        const rank = room.buzzList.length + 1;
        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;

        room.buzzList.push({
          id: socket.id,
          rank: `#${rank}`,
          name: socket.playerName || 'Anonymous',
          time: timeStr
        });

        // 广播最新的抢答排行榜
        io.to(roomCode).emit('buzz_update', room.buzzList);
        console.log(`[Buzzed] ${socket.playerName} rank ${rank} in room ${roomCode}`);
      }
    }
  });

  // 9. Host 触发音效/特效
  socket.on('trigger_effect', (type) => {
    const roomCode = socket.roomCode;
    if (roomCode && socket.isHost) {
      io.to(roomCode).emit('play_effect', type);
      console.log(`[Effect Triggered] Type: ${type} in room ${roomCode}`);
    }
  });
});

// 监听端口（兼容 Render 动态端口）
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Buzz Lightyear backend server running on port ${PORT}`);
});