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

    console.log(`[Host Relogin] Host re-joined room: ${upperRoom}`);
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

    // 如果玩家不在列表中则添加
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) {
      room.players.push({ id: socket.id, name: socket.playerName });
    } else {
      room.players[playerIndex].name = socket.playerName;
    }

    console.log(`[Player Joined] ${socket.playerName} joined room ${upperRoom}`);

    // ⚡ 实时广播给房间内的所有人（主要是 Host）更新玩家列表
    io.to(upperRoom).emit('player_list_updated', room.players);

    callback({ success: true, isCanBuzz: room.canBuzz });
  });

  // 4. Host 开始新一轮抢答
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

  // 5. Host 重置/清空当前轮
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

  // 6. 玩家按下抢答器
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

  // 7. Host 触发音效/烟花特效
  socket.on('trigger_effect', (type) => {
    const roomCode = socket.roomCode;
    if (roomCode && socket.isHost) {
      io.to(roomCode).emit('play_effect', type);
      console.log(`[Effect Triggered] Type: ${type} in room ${roomCode}`);
    }
  });

  // 8. ⚡ 核心：玩家退出/关闭网页断开连接 (Live Disconnect)
  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    console.log(`[Disconnect] Client left: ${socket.id}`);

    if (roomCode && rooms[roomCode] && socket.isPlayer) {
      const room = rooms[roomCode];
      
      // 从在线玩家列表中踢出断连的玩家
      room.players = room.players.filter(p => p.id !== socket.id);

      // ⚡ 立即实时广播给 Host 最新的在线玩家列表
      io.to(roomCode).emit('player_list_updated', room.players);
      console.log(`[Live Update] ${socket.playerName} disconnected from room ${roomCode}. Remaining: ${room.players.length}`);
    }
  });
});

// 监听端口（兼容 Render 动态端口）
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Buzz Lightyear backend server running on port ${PORT}`);
});