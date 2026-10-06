const UserModel = require('../models/User');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const {
    signAccessToken,
    verifyAccessToken,
    signResetToken,
    verifyResetToken
} = require('../config/jwt');
const { sendPasswordReset } = require('../services/mailer');
const RegistrationOtp = require('../services/registrationOtp');
const EmailChangeOtp = require('../services/emailChangeOtp');
const { sendError } = require('../utils/http');
const { ROLES, DEFAULT_ROLE, USER_STATUSES } = require('../config/roles');

// Đăng ký công khai CHỈ tạo 'customer'; admin/staff chỉ do admin tạo (POST /api/users). Xem config/roles.js
const PASSWORD_MIN = 6; // khớp với kiểm tra ở trang đăng ký của storefront
const PASSWORD_MAX = 72; // bcrypt chỉ dùng 72 byte đầu
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INVALID_RESET = 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn';

const isStr = (v) => typeof v === 'string';

/** Trả về chuỗi lỗi (tiếng Việt) nếu dữ liệu tạo tài khoản không hợp lệ, ngược lại trả null. */
function validateNewUser({ username, password, email, full_name }) {
    const fields = [username, password, email, full_name];
    if (!fields.every(isStr) || !fields.every((v) => v.trim())) {
        return 'Vui lòng nhập đầy đủ thông tin';
    }
    if (!/^\S{3,50}$/.test(username.trim())) return 'Tên đăng nhập phải từ 3 đến 50 ký tự, không chứa khoảng trắng';
    if (password.length < PASSWORD_MIN) return `Mật khẩu phải có ít nhất ${PASSWORD_MIN} ký tự`;
    if (password.length > PASSWORD_MAX) return `Mật khẩu tối đa ${PASSWORD_MAX} ký tự`;
    if (!EMAIL_RE.test(email.trim()) || email.length > 150) return 'Email không hợp lệ';
    if (full_name.trim().length > 100) return 'Họ tên quá dài (tối đa 100 ký tự)';
    return null;
}

// Lỗi do cột `role` trong DB chưa có giá trị 'customer' (chưa chạy migration)
const isRoleColumnError = (err) =>
    err && ['WARN_DATA_TRUNCATED', 'ER_WARN_DATA_OUT_OF_RANGE', 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD'].includes(err.code);

async function createAccount(res, data, successMessage) {
    const existingUser = await UserModel.getUserByUsername(data.username);
    if (existingUser) return res.status(400).json({ success: false, message: 'Tên đăng nhập đã tồn tại' });
    const existingEmail = await UserModel.getUserByEmail(data.email);
    if (existingEmail) return res.status(400).json({ success: false, message: 'Email đã được sử dụng' });

    try {
        const userId = await UserModel.createUser(data);
        return res.status(201).json({ success: true, message: successMessage, data: { id: userId } });
    } catch (error) {
        if (isRoleColumnError(error)) {
            console.error(
                `❌ Không thể tạo tài khoản với role "${data.role}": cột users.role chưa hỗ trợ giá trị này. ` +
                'Hãy chạy: npm run fix-roles -- --apply (xem ROLES.md)'
            );
            return res.status(503).json({ success: false, message: 'Chức năng đăng ký tạm thời chưa khả dụng, vui lòng thử lại sau' });
        }
        throw error;
    }
}

/** Thông báo sau khi tạo mã OTP. Chưa cấu hình gửi email (chạy thử): mã hiện ngay trên trang thay vì gửi email. */
const sentMessage = (info, normal) => (info && info.dev_code
    ? 'Chưa cấu hình gửi email (SMTP) nên đang ở chế độ chạy thử: mã xác nhận hiện ngay trên trang.'
    : normal);

class UserController {
    static async login(req, res) {
        try {
            const { username, password } = req.body || {};
            if (!isStr(username) || !isStr(password) || !username || !password) {
                return res.status(400).json({ success: false, message: 'Vui lòng nhập tên đăng nhập và mật khẩu' });
            }

            const user = await UserModel.getUserByUsername(username);
            // Kiểm tra mật khẩu TRƯỚC khi nói gì về trạng thái tài khoản để không lộ tài khoản nào tồn tại/bị khóa
            const isValidPassword = user ? await UserModel.verifyPassword(user, password) : false;
            if (!isValidPassword) {
                return res.status(401).json({ success: false, message: 'Tên đăng nhập hoặc mật khẩu không đúng' });
            }
            if (user.status !== 'active') {
                return res.status(401).json({ success: false, message: 'Tài khoản đã bị khóa' });
            }

            await UserModel.updateLastLogin(user.id);
            const publicUser = await UserModel.getUserById(user.id);
            const token = signAccessToken(publicUser);

            res.json({ success: true, message: 'Đăng nhập thành công', data: { token, user: publicUser } });
        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }

    /** Đăng ký công khai (khách hàng). Mọi trường `role`/`status` do client gửi đều bị bỏ qua. */
    /**
     * Đăng ký bước 1: kiểm tra dữ liệu rồi GỬI MÃ OTP tới email. Tài khoản chỉ được tạo ở bước 2 (verifyRegistration),
     * sau khi người dùng nhập đúng mã => chắc chắn email là thật và thuộc về người đăng ký.
     */
    static async register(req, res) {
        try {
            const body = req.body || {};
            const problem = validateNewUser(body);
            if (problem) return res.status(400).json({ success: false, message: problem });

            const info = await RegistrationOtp.start({
                username: body.username.trim(),
                password: body.password,
                email: body.email.trim(),
                full_name: body.full_name.trim()
            });
            res.json({
                success: true,
                message: sentMessage(info, `Đã gửi mã xác nhận tới ${info.masked_email}. Vui lòng kiểm tra hộp thư (cả mục Spam/Quảng cáo).`),
                data: info
            });
        } catch (error) {
            sendError(res, error, 'Không đăng ký được, vui lòng thử lại sau');
        }
    }

    /** Đăng ký bước 2: nhập đúng mã OTP => tạo tài khoản 'customer' và đăng nhập luôn. */
    static async verifyRegistration(req, res) {
        try {
            const { email, code } = req.body || {};
            if (!isStr(email) || !isStr(code) || !email.trim() || !code.trim()) {
                return res.status(400).json({ success: false, message: 'Vui lòng nhập email và mã xác nhận' });
            }
            const data = await RegistrationOtp.verify(email, code);

            // Kiểm tra lại: trong lúc chờ nhập mã, có thể người khác đã lấy tên đăng nhập/email này
            if (await UserModel.getUserByUsername(data.username)) {
                return res.status(409).json({ success: false, message: 'Tên đăng nhập vừa được người khác sử dụng. Vui lòng đăng ký lại với tên khác.' });
            }
            if (await UserModel.getUserByEmail(data.email)) {
                return res.status(409).json({ success: false, message: 'Email đã được sử dụng' });
            }

            let userId;
            try {
                userId = await UserModel.createUser({
                    username: data.username,
                    password_hash: data.password_hash,
                    email: data.email,
                    full_name: data.full_name,
                    role: DEFAULT_ROLE
                });
            } catch (error) {
                if (isRoleColumnError(error)) {
                    console.error('❌ Không thể tạo tài khoản: cột users.role chưa hỗ trợ "customer". Hãy chạy: npm run fix-roles -- --apply (xem ROLES.md)');
                    return res.status(503).json({ success: false, message: 'Chức năng đăng ký tạm thời chưa khả dụng, vui lòng thử lại sau' });
                }
                if (error && error.code === 'ER_DUP_ENTRY') {
                    return res.status(409).json({ success: false, message: 'Tên đăng nhập hoặc email đã được sử dụng' });
                }
                throw error;
            }

            await UserModel.updateLastLogin(userId);
            const user = await UserModel.getUserById(userId);
            const token = signAccessToken(user);
            res.status(201).json({ success: true, message: 'Xác nhận email thành công. Tài khoản đã được tạo!', data: { token, user } });
        } catch (error) {
            sendError(res, error, 'Không xác nhận được, vui lòng thử lại sau');
        }
    }

    /** Đổi email bước 1: kiểm tra mật khẩu hiện tại, gửi mã OTP tới email mới. */
    static async requestEmailChange(req, res) {
        try {
            const info = await EmailChangeOtp.start(req.user.id, req.body || {});
            res.json({ success: true, message: sentMessage(info, `Đã gửi mã xác nhận tới ${info.masked_email}.`), data: info });
        } catch (error) {
            sendError(res, error, 'Không gửi được mã xác nhận, vui lòng thử lại sau');
        }
    }

    /** Đổi email bước 2: nhập đúng mã => cập nhật email. */
    static async verifyEmailChange(req, res) {
        try {
            const { new_email, code } = req.body || {};
            if (!isStr(new_email) || !isStr(code) || !new_email.trim() || !code.trim()) {
                return res.status(400).json({ success: false, message: 'Vui lòng nhập email mới và mã xác nhận' });
            }
            await EmailChangeOtp.verify(req.user.id, new_email, code);
            const user = await UserModel.getUserById(req.user.id);
            res.json({ success: true, message: 'Đổi email thành công', data: user });
        } catch (error) {
            if (error && error.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: 'Email đã được sử dụng' });
            sendError(res, error, 'Không đổi được email, vui lòng thử lại sau');
        }
    }

    static async resendEmailChange(req, res) {
        try {
            const { new_email } = req.body || {};
            if (!isStr(new_email) || !new_email.trim()) return res.status(400).json({ success: false, message: 'Vui lòng nhập email mới' });
            const info = await EmailChangeOtp.resend(req.user.id, new_email);
            res.json({ success: true, message: sentMessage(info, `Đã gửi mã mới tới ${info.masked_email}.`), data: info });
        } catch (error) {
            sendError(res, error, 'Không gửi lại được mã, vui lòng thử lại sau');
        }
    }

    /** Gửi lại mã OTP đăng ký (có thời gian chờ và giới hạn số lần). */
    static async resendRegistrationOtp(req, res) {
        try {
            const { email } = req.body || {};
            if (!isStr(email) || !email.trim()) return res.status(400).json({ success: false, message: 'Vui lòng nhập email' });
            const info = await RegistrationOtp.resend(email);
            res.json({ success: true, message: sentMessage(info, `Đã gửi mã mới tới ${info.masked_email}.`), data: info });
        } catch (error) {
            sendError(res, error, 'Không gửi lại được mã, vui lòng thử lại sau');
        }
    }

    /** Admin tạo tài khoản nhân viên/quản trị: POST /api/users (chỉ admin). */
    static async createUser(req, res) {
        try {
            const body = req.body || {};
            const problem = validateNewUser(body);
            if (problem) return res.status(400).json({ success: false, message: problem });

            const role = body.role === undefined ? 'staff' : body.role; // admin tạo tài khoản mà không nêu vai trò -> nhân viên
            if (!ROLES.includes(role)) {
                return res.status(400).json({ success: false, message: `Vai trò không hợp lệ. Giá trị cho phép: ${ROLES.join(', ')}` });
            }

            await createAccount(
                res,
                {
                    username: body.username.trim(),
                    password: body.password,
                    email: body.email.trim(),
                    full_name: body.full_name.trim(),
                    role
                },
                'Tạo tài khoản thành công'
            );
        } catch (error) {
            console.error('Create user error:', error);
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
            const { full_name, email, avatar } = req.body || {};
            // Khách hàng đổi email phải xác nhận bằng mã OTP gửi tới email mới (POST /users/me/email).
            // Tài khoản nhân viên/admin do admin tạo nên vẫn đổi trực tiếp như trước.
            if (email !== undefined && req.user.role === DEFAULT_ROLE) {
                const current = await UserModel.getUserById(userId);
                if (!current || !isStr(email) || email.trim().toLowerCase() !== String(current.email).toLowerCase()) {
                    return res.status(400).json({
                        success: false,
                        message: 'Đổi email cần xác nhận bằng mã gửi tới email mới. Vui lòng dùng chức năng "Đổi email".'
                    });
                }
            }
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

            const actorId = req.user ? req.user.id : undefined;
            const isSelf = actorId !== undefined && Number(id) === actorId;

            if (status !== undefined && !USER_STATUSES.includes(status)) {
                return res.status(400).json({ success: false, message: `Trạng thái không hợp lệ. Giá trị cho phép: ${USER_STATUSES.join(', ')}` });
            }
            // Admin không tự đổi vai trò / tự khóa chính mình (tránh tự mất quyền hoặc khóa hệ thống)
            if (isSelf && role !== undefined && role !== user.role) {
                return res.status(400).json({ success: false, message: 'Bạn không thể tự đổi vai trò của chính mình' });
            }
            if (isSelf && status !== undefined && status !== user.status) {
                return res.status(400).json({ success: false, message: 'Bạn không thể tự khóa tài khoản của chính mình' });
            }

            if (role !== undefined) {
                if (!ROLES.includes(role)) {
                    return res.status(400).json({ success: false, message: `Vai trò không hợp lệ. Giá trị cho phép: ${ROLES.join(', ')}` });
                }
                // Không cho hạ quyền admin duy nhất (tránh tự khóa hệ thống)
                if (user.role === 'admin' && role !== 'admin') {
                    const admins = (await UserModel.getAllUsers()).filter((u) => u.role === 'admin');
                    if (admins.length <= 1) {
                        return res.status(400).json({ success: false, message: 'Không thể hạ quyền admin duy nhất' });
                    }
                }
            }
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
            const { current_password, new_password } = req.body || {};
            if (!isStr(current_password) || !isStr(new_password) || !current_password || !new_password) {
                return res.status(400).json({ success: false, message: 'Vui lòng nhập mật khẩu hiện tại và mật khẩu mới' });
            }
            if (new_password.length < PASSWORD_MIN || new_password.length > PASSWORD_MAX) {
                return res.status(400).json({ success: false, message: `Mật khẩu mới phải từ ${PASSWORD_MIN} đến ${PASSWORD_MAX} ký tự` });
            }
            const user = await UserModel.getUserAuthById(req.user.id);
            if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
            const isValid = await bcrypt.compare(current_password, user.password);
            // 400 chứ không phải 401: người dùng vẫn đang đăng nhập hợp lệ, chỉ nhập sai mật khẩu cũ (401 khiến giao diện tưởng hết phiên và đăng xuất)
            if (!isValid) return res.status(400).json({ success: false, message: 'Mật khẩu hiện tại không đúng' });
            await UserModel.updatePassword(req.user.id, new_password);
            res.json({ success: true, message: 'Đổi mật khẩu thành công' });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async deleteUser(req, res) {
        try {
            const { id } = req.params;
            if (req.user && Number(id) === req.user.id) {
                return res.status(400).json({ success: false, message: 'Bạn không thể tự xóa tài khoản của chính mình' });
            }
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
            const { token } = req.body || {};
            if (!isStr(token) || !token) return res.status(400).json({ success: false, message: 'Thiếu token' });
            const decoded = verifyAccessToken(token);
            const user = await UserModel.getUserById(decoded.id);
            if (!user || user.status !== 'active') {
                return res.status(401).json({ success: false, message: 'Token không hợp lệ' });
            }
            res.json({ success: true, data: { token: signAccessToken(user) } });
        } catch {
            res.status(401).json({ success: false, message: 'Token không hợp lệ hoặc đã hết hạn' });
        }
    }

    /**
     * Quên mật khẩu. KHÔNG bao giờ trả token trong response (trước đây ai biết email cũng chiếm được tài khoản)
     * và luôn trả cùng một thông báo dù email có tồn tại hay không (chống dò email).
     */
    static async forgotPassword(req, res) {
        const generic = {
            success: true,
            message: 'Nếu email tồn tại trong hệ thống, hướng dẫn đặt lại mật khẩu đã được gửi.'
        };
        try {
            const { email } = req.body || {};
            if (!isStr(email) || !email.trim()) {
                return res.status(400).json({ success: false, message: 'Vui lòng nhập email' });
            }
            const user = await UserModel.getUserByEmail(email.trim());
            if (user && user.status === 'active') {
                await sendPasswordReset(user, signResetToken(user));
            }
        } catch (error) {
            // Chỉ ghi log phía server; người gọi không được biết có lỗi hay không
            console.error('Forgot password error:', error.message);
        }
        res.json(generic);
    }

    static async resetPassword(req, res) {
        try {
            const { token, new_password } = req.body || {};
            if (!isStr(token) || !isStr(new_password) || !token || !new_password) {
                return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ thông tin' });
            }
            if (new_password.length < PASSWORD_MIN || new_password.length > PASSWORD_MAX) {
                return res.status(400).json({ success: false, message: `Mật khẩu mới phải từ ${PASSWORD_MIN} đến ${PASSWORD_MAX} ký tự` });
            }

            // Đọc id từ token (chưa tin cậy) để lấy hash mật khẩu hiện tại, rồi mới xác thực chữ ký bằng khóa riêng của user đó
            const claims = jwt.decode(token);
            if (!claims || !Number.isInteger(claims.id)) {
                return res.status(400).json({ success: false, message: INVALID_RESET });
            }
            const user = await UserModel.getUserAuthById(claims.id);
            if (!user || user.status !== 'active') {
                return res.status(400).json({ success: false, message: INVALID_RESET });
            }
            try {
                verifyResetToken(token, user);
            } catch {
                return res.status(400).json({ success: false, message: INVALID_RESET });
            }

            await UserModel.updatePassword(user.id, new_password); // đổi hash -> token vừa dùng tự vô hiệu
            res.json({ success: true, message: 'Đặt lại mật khẩu thành công' });
        } catch (error) {
            console.error('Reset password error:', error.message);
            res.status(500).json({ success: false, message: 'Không thể đặt lại mật khẩu, vui lòng thử lại' });
        }
    }

    static async logout(req, res) {
        res.json({ success: true, message: 'Đăng xuất thành công' });
    }
}

module.exports = UserController;
