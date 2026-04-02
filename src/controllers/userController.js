const UserModel = require('../models/User');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

class UserController {
    static async login(req, res) {
        try {
            const { username, password } = req.body;
            if (!username || !password) {
                return res.status(400).json({ success: false, message: 'Vui lòng nhập tên đăng nhập và mật khẩu' });
            }

            const user = await UserModel.getUserByUsername(username);
            if (!user) {
                return res.status(401).json({ success: false, message: 'Tên đăng nhập hoặc mật khẩu không đúng' });
            }
            if (user.status !== 'active') {
                return res.status(401).json({ success: false, message: 'Tài khoản đã bị khóa' });
            }

            const isValidPassword = await UserModel.verifyPassword(user, password);
            if (!isValidPassword) {
                return res.status(401).json({ success: false, message: 'Tên đăng nhập hoặc mật khẩu không đúng' });
            }

            await UserModel.updateLastLogin(user.id);
            const publicUser = await UserModel.getUserById(user.id);
            const token = jwt.sign({ id: publicUser.id, username: publicUser.username, role: publicUser.role }, JWT_SECRET, { expiresIn: '7d' });

            res.json({ success: true, message: 'Đăng nhập thành công', data: { token, user: publicUser } });
        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async register(req, res) {
        try {
            const { username, password, email, full_name, role = 'staff' } = req.body;
            if (!username || !password || !email || !full_name) {
                return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ thông tin' });
            }
            const existingUser = await UserModel.getUserByUsername(username);
            if (existingUser) return res.status(400).json({ success: false, message: 'Tên đăng nhập đã tồn tại' });
            const existingEmail = await UserModel.getUserByEmail(email);
            if (existingEmail) return res.status(400).json({ success: false, message: 'Email đã được sử dụng' });

            const userId = await UserModel.createUser({ username, password, email, full_name, role });
            res.status(201).json({ success: true, message: 'Đăng ký thành công', data: { id: userId } });
        } catch (error) {
            console.error('Register error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getAllUsers(req, res) {
        try {
            const users = await UserModel.getAllUsers();
            res.json({ success: true, data: users });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getUserById(req, res) {
        try {
            const user = await UserModel.getUserById(req.params.id);
            if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
            res.json({ success: true, data: user });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getCurrentUser(req, res) {
        try {
            const user = await UserModel.getUserById(req.user.id);
            if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
            res.json({ success: true, data: user });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async updateCurrentUser(req, res) {
        try {
            const userId = req.user.id;
            const { full_name, email, avatar } = req.body;
            if (email) {
                const existing = await UserModel.getUserByEmail(email);
                if (existing && existing.id !== userId) {
                    return res.status(400).json({ success: false, message: 'Email đã được sử dụng' });
                }
            }
            const affectedRows = await UserModel.updateUser(userId, { full_name, email, avatar });
            if (affectedRows === 0) return res.status(400).json({ success: false, message: 'Không có dữ liệu cần cập nhật' });
            const updatedUser = await UserModel.getUserById(userId);
            res.json({ success: true, message: 'Cập nhật thông tin thành công', data: updatedUser });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async updateUser(req, res) {
        try {
            const { id } = req.params;
            const { full_name, email, avatar, role, status } = req.body;
            const user = await UserModel.getUserById(id);
            if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
            if (email) {
                const existing = await UserModel.getUserByEmail(email);
                if (existing && existing.id !== Number(id)) {
                    return res.status(400).json({ success: false, message: 'Email đã được sử dụng' });
                }
            }
            const affectedRows = await UserModel.updateUser(id, { full_name, email, avatar, role, status });
            if (affectedRows === 0) return res.status(400).json({ success: false, message: 'Không có dữ liệu cần cập nhật' });
            const updatedUser = await UserModel.getUserById(id);
            res.json({ success: true, message: 'Cập nhật người dùng thành công', data: updatedUser });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async updatePassword(req, res) {
        try {
            const { current_password, new_password } = req.body;
            if (!current_password || !new_password) {
                return res.status(400).json({ success: false, message: 'Vui lòng nhập mật khẩu hiện tại và mật khẩu mới' });
            }
            const user = await UserModel.getUserAuthById(req.user.id);
            if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
            const isValid = await bcrypt.compare(current_password, user.password);
            if (!isValid) return res.status(401).json({ success: false, message: 'Mật khẩu hiện tại không đúng' });
            await UserModel.updatePassword(req.user.id, new_password);
            res.json({ success: true, message: 'Đổi mật khẩu thành công' });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async deleteUser(req, res) {
        try {
            const { id } = req.params;
            const users = await UserModel.getAllUsers();
            const adminCount = users.filter((u) => u.role === 'admin').length;
            const userToDelete = await UserModel.getUserById(id);
            if (userToDelete && userToDelete.role === 'admin' && adminCount === 1) {
                return res.status(400).json({ success: false, message: 'Không thể xóa admin duy nhất' });
            }
            const affectedRows = await UserModel.deleteUser(id);
            if (affectedRows === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
            res.json({ success: true, message: 'Xóa người dùng thành công' });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async refreshToken(req, res) {
        try {
            const { token } = req.body;
            if (!token) return res.status(400).json({ success: false, message: 'Thiếu token' });
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await UserModel.getUserById(decoded.id);
            if (!user) return res.status(401).json({ success: false, message: 'Token không hợp lệ' });
            const newToken = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
            res.json({ success: true, data: { token: newToken } });
        } catch {
            res.status(401).json({ success: false, message: 'Token không hợp lệ hoặc đã hết hạn' });
        }
    }

    static async forgotPassword(req, res) {
        try {
            const { email } = req.body;
            if (!email) return res.status(400).json({ success: false, message: 'Vui lòng nhập email' });
            const user = await UserModel.getUserByEmail(email);
            if (!user) return res.status(404).json({ success: false, message: 'Email không tồn tại trong hệ thống' });
            const resetToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
            res.json({ success: true, message: 'Link reset mật khẩu đã được gửi đến email của bạn', data: { reset_token: resetToken } });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async resetPassword(req, res) {
        try {
            const { token, new_password } = req.body;
            if (!token || !new_password) return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ thông tin' });
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await UserModel.getUserById(decoded.id);
            if (!user) return res.status(404).json({ success: false, message: 'Token không hợp lệ' });
            await UserModel.updatePassword(user.id, new_password);
            res.json({ success: true, message: 'Đặt lại mật khẩu thành công' });
        } catch {
            res.status(401).json({ success: false, message: 'Token không hợp lệ hoặc đã hết hạn' });
        }
    }

    static async logout(req, res) {
        res.json({ success: true, message: 'Đăng xuất thành công' });
    }
}

module.exports = UserController;
