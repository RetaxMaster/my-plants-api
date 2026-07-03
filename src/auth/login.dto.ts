import { IsNotEmpty, IsString } from 'class-validator';

// Validate the login payload so a missing/empty username or password is rejected with a clean 400
// (via the global ValidationPipe), instead of reaching Prisma with `username: undefined` and
// throwing a PrismaClientValidationError (surfacing as a 500). Wrong-but-well-formed credentials
// still return a generic 401 from AuthService (no user enumeration).
export class LoginDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
