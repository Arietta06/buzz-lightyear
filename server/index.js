const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 保存内存房间数据
const rooms = {};

io.on('connection', (socket) => {
  console.log(`[Connected] Socket ID: ${socket.id}`);

  // 1. Host 创建房间
  socket.on('create_room', ({ roomCode, hostCode }, callback) => {
    if (!roomCode || !hostCode) {
      return callback({ success: false, message: 'Room Code and Passcode are required.' });
    }
    
    if (rooms[roomCode]) {
      return callback({ success: false, message: 'Room code already exists. Try re-logging in.' });
    }

    rooms[roomCode] = {
      hostCode,
      hostSocketId: socket.id,
      players: [],
      buzzList: [],
      isCanBuzz: false,
      startTime: null
    };

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = true;

    console.log(`[Room Created] ${roomCode}`);
    callback({ 
      success: true, 
      roomData: { 
        buzzList: rooms[roomCode].buzzList, 
        players: rooms[roomCode].players 
      } 
    });
  });

  // 2. Host 重新登录
  socket.on('host_login', ({ roomCode, hostCode }, callback) => {
    const room = rooms[roomCode];
    if (!room) {
      return callback({ success: false, message: 'Room does not exist.' });
    }
    if (room.hostCode !== hostCode) {
      return callback({ success: false, message: 'Incorrect Host Passcode!' });
    }

    room.hostSocketId = socket.id;
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = true;

    console.log(`[Host Re-logged in] Room: ${roomCode}`);
    callback({ 
      success: true, 
      roomData: { 
        buzzList: room.buzzList, 
        players: room.players 
      } 
    });
  });

  // 3. 玩家加入房间
  socket.on('join_player', ({ roomCode, name }, callback) => {
    const room = rooms[roomCode];
    if (!room) {
      return callback({ success: false, message: 'Room does not exist or has been deleted.' });
    }

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerName = name;
    socket.isHost = false;

    const existingPlayerIndex = room.players.findIndex(p => p.id === socket.id);
    if (existingPlayerIndex !== -1) {
      room.players[existingPlayerIndex].name = name;
    } else {
      room.players.push({ id: socket.id, name });
    }

    io.to(roomCode).emit('player_list_updated', room.players);

    console.log(`[Player Joined] ${name} -> Room: ${roomCode}`);
    callback({ success: true, isCanBuzz: room.isCanBuzz });
  });

  // 4. Host 开启抢答 (Start Round)
  socket.on('start_round', () => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (room && socket.isHost) {
      room.isCanBuzz = true;
      room.buzzList = [];
      room.startTime = Date.now();

      io.to(roomCode).emit('round_started');
      io.to(roomCode).emit('buzz_update', []);
      console.log(`[Round Started] Room: ${roomCode}`);
    }
  });

  // 5. Host 重置/清空抢答 (Reset Round)
  socket.on('reset_round', () => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (room && socket.isHost) {
      room.isCanBuzz = false;
      room.buzzList = [];
      room.startTime = null;

      io.to(roomCode).emit('round_reset');
      console.log(`[Round Reset] Room: ${roomCode}`);
    }
  });

  // 6. 玩家按下 Buzzer 抢答
  socket.on('press_buzzer', () => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];

    if (room && room.isCanBuzz && !socket.isHost) {
      const alreadyBuzzed = room.buzzList.some(b => b.id === socket.id);
      if (!alreadyBuzzed) {
        const timeDiff = ((Date.now() - room.startTime) / 1000).toFixed(2);
        const rank = room.buzzList.length + 1;

        const buzzRecord = {
          id: socket.id,
          rank: `#${rank}`,
          name: socket.playerName || 'Anonymous',
          time: `+${timeDiff}s`
        };

        room.buzzList.push(buzzRecord);
        io.to(roomCode).emit('buzz_update', room.buzzList);
        console.log(`[Buzzed] ${socket.playerName} (#${rank}) in Room: ${roomCode}`);
      }
    }
  });

  // 7. Host 触发音效/动画特效
  socket.on('trigger_effect', (type) => {
    const roomCode = socket.roomCode;
    if (roomCode && socket.isHost) {
      io.to(roomCode).emit('play_effect', type);
    }
  });

  // 8. 🗑️ Host 删除房间 (Delete Room)
  socket.on('delete_room', (data, callback) => {
    const cb = typeof data === 'function' ? data : callback;
    const roomCode = (typeof data === 'object' && data?.roomCode) ? data.roomCode : socket.roomCode;
    const room = rooms[roomCode];

    if (roomCode && room) {
      console.log(`[Deleting Room] ${roomCode}`);

      io.to(roomCode).emit('room_deleted');
      io.in(roomCode).socketsLeave(roomCode);

      delete rooms[roomCode];

      socket.roomCode = null;
      socket.isHost = false;

      if (typeof cb === 'function') {
        cb({ success: true });
      }
    } else {
      console.log(`[Delete Failed] Room ${roomCode} not found.`);
      if (typeof cb === 'function') {
        cb({ success: false, message: 'Room not found.' });
      }
    }
  });

  // 9. 玩家手动离开房间
  socket.on('leave_room', () => {
    handleUserDisconnect(socket);
  });

  // 10. 连接断开处理 (Disconnect)
  socket.on('disconnect', () => {
    console.log(`[Disconnected] Socket ID: ${socket.id}`);
    handleUserDisconnect(socket);
  });

  function handleUserDisconnect(s) {
    const roomCode = s.roomCode;
    const room = rooms[roomCode];

    if (room && !s.isHost) {
      room.players = room.players.filter(p => p.id !== s.id);
      s.leave(roomCode);
      io.to(roomCode).emit('player_list_updated', room.players);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`🚀 Buzz Lightyear Server is Running!`);
  console.log(`📡 Listening on Port: ${PORT}`);
  console.log(`=================================`);
});