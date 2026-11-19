import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Render,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { OrderPresentationService } from '../orders/order-presentation.service';
import { ProductsService } from '../products/products.service';
import { CheckoutSession } from '../checkout/checkout-session.entity';
import { SessionAuthGuard } from '../auth/guard/session-auth.guard';
import { SameOriginGuard } from '../auth/guard/same-origin.guard';
import { Roles } from '../auth/guard/roles.decorator';
import { TypeOfUser } from '../auth/auth.dto';
import type { AuthRequest } from '../auth/utils/auth-request';
import { MaskPii } from '../interceptor/pii/mask-pii.decorator';
import { ReturnsService } from './returns.service';
import { OrderReturn } from './return.entity';
import {
  CreateReturnDto,
  EvidenceIdDto,
  ReturnActionDto,
  ReturnIdDto,
} from './return.dto';

@Controller('returns')
@UseGuards(SessionAuthGuard)
@Roles(TypeOfUser.Buyer, TypeOfUser.Seller)
@MaskPii(false)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class ReturnsController {
  private readonly directory = resolve(
    process.env.RETURN_EVIDENCE_DIR ??
      join(__dirname, '../../storage/private/returns'),
  );
  constructor(
    private readonly returns: ReturnsService,
    private readonly products: ProductsService,
    private readonly presentation: OrderPresentationService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Render('returns')
  page() {
    return { title: 'Returns' };
  }
  @Get('data')
  @Header('Cache-Control', 'no-store')
  async list(@Req() request: AuthRequest) {
    const user = request.user!;
    const records = await this.returns.list(user);
    const options = user.roles.includes(TypeOfUser.Buyer)
      ? await this.products.withStockTransaction(async (manager) => {
          const sessions = await manager.find(CheckoutSession, {
            where: { buyerId: user.sub, status: 'completed' },
            order: { createdAt: 'DESC' },
            take: 100,
          });
          const existing = await manager.find(OrderReturn, {
            where: { buyerId: user.sub },
          });
          return sessions
            .filter((session) => session.order?.status === 'paid')
            .flatMap((session) =>
              session
                .order!.sellerOrders.filter(
                  (seller) => seller.fulfillment === 'delivered',
                )
                .map((seller) => ({
                  checkoutId: session.id,
                  orderId: session.order!.id,
                  session,
                  sellerOrderId: seller.id,
                  items: seller.items.map((item) => ({
                    ...item,
                    available:
                      item.quantity -
                      existing
                        .filter(
                          (record) =>
                            record.checkoutId === session.id &&
                            record.sellerOrderId === seller.id &&
                            record.status !== 'rejected',
                        )
                        .reduce(
                          (sum, record) =>
                            sum +
                            (record.data.items.find(
                              (line) => line.productId === item.productId,
                            )?.quantity ?? 0),
                          0,
                        ),
                  })),
                })),
            )
            .filter((seller) =>
              seller.items.some((item) => item.available > 0),
            );
        })
      : [];
    const sessions = [
      ...new Map(
        options.map((option) => [option.session.id, option.session]),
      ).values(),
    ];
    const display = await this.presentation.describe(sessions);
    const orders = options.map(({ session, ...option }) => {
      const order = display.find((value) => value.id === session.id)!;
      const seller = order.sellers.find(
        (value) => value.id === option.sellerOrderId,
      )!;
      return {
        ...option,
        orderNumber: order.orderNumber,
        placedAt: order.placedAt,
        sellerName: seller.sellerName,
        items: option.items.map((item) => ({
          ...item,
          thumbnail:
            seller.items.find((value) => value.productId === item.productId)
              ?.thumbnail ?? null,
        })),
      };
    });
    return { returns: records, orders };
  }
  @Post('requests')
  @UseGuards(SameOriginGuard)
  request(@Req() request: AuthRequest, @Body() input: CreateReturnDto) {
    return this.returns.request(request.user!, input);
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @Render('returns')
  async detail(@Req() request: AuthRequest, @Param() params: ReturnIdDto) {
    await this.returns.get(params.id, request.user!);
    return { title: 'Return details', returnId: params.id };
  }
  @Get(':id/data')
  @Header('Cache-Control', 'no-store')
  get(@Req() request: AuthRequest, @Param() params: ReturnIdDto) {
    return this.returns.get(params.id, request.user!);
  }
  @Post(':id/actions')
  @UseGuards(SameOriginGuard)
  action(
    @Req() request: AuthRequest,
    @Param() params: ReturnIdDto,
    @Body() input: ReturnActionDto,
  ) {
    return this.returns.action(params.id, request.user!, input);
  }
  @Post(':id/evidence')
  @UseInterceptors(
    FilesInterceptor('files', 5, {
      limits: { fileSize: 5 * 1024 * 1024, files: 5, fields: 0 },
    }),
  )
  async evidence(
    @Req() request: AuthRequest,
    @Param() params: ReturnIdDto,
    @UploadedFiles() files: { buffer: Buffer }[],
  ) {
    if (
      request.get('origin') &&
      request.get('origin') !== `${request.protocol}://${request.get('host')}`
    )
      throw new BadRequestException('Invalid request origin');
    const record = await this.returns.get(params.id, request.user!);
    if (!files?.length || record.status === 'resolved')
      throw new BadRequestException('Attach images to an open return');
    const encoded = await Promise.all(
      files.map(async (file) => {
        const image = sharp(file.buffer, {
          limitInputPixels: 40_000_000,
          animated: false,
        });
        const metadata = await image.metadata();
        if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? ''))
          throw new BadRequestException('Use JPEG, PNG or WebP images');
        return {
          id: randomUUID(),
          bytes: await image
            .rotate()
            .resize({
              width: 2000,
              height: 2000,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .jpeg({ quality: 85 })
            .toBuffer(),
        };
      }),
    );
    await mkdir(this.directory, { recursive: true });
    const written: string[] = [];
    try {
      for (const file of encoded) {
        const path = join(this.directory, `${file.id}.jpg`);
        await writeFile(path, file.bytes, { mode: 0o600 });
        written.push(path);
      }
      await this.products.withStockTransaction(async (manager) => {
        const current = await this.returns.owned(
          manager,
          params.id,
          request.user!,
        );
        if (
          current.status === 'resolved' ||
          current.data.evidence.length + encoded.length > 20
        )
          throw new BadRequestException(
            'Return is closed or has reached its 20-photo limit',
          );
        current.data.evidence.push(
          ...encoded.map((file) => ({
            id: file.id,
            at: Date.now(),
            author: record.canReview ? ('seller' as const) : ('buyer' as const),
          })),
        );
        current.revision++;
        await manager.save(OrderReturn, current);
      });
    } catch (error) {
      await Promise.all(written.map((path) => unlink(path).catch(() => {})));
      throw error;
    }
    return this.returns.get(params.id, request.user!);
  }
  @Get(':id/evidence/:evidenceId')
  @Header('Cache-Control', 'private, no-store')
  async image(
    @Req() request: AuthRequest,
    @Param() params: EvidenceIdDto,
    @Res() response: Response,
  ) {
    const record = await this.returns.get(params.id, request.user!);
    if (!record.evidence.some((value) => value.id === params.evidenceId))
      throw new BadRequestException('Image not found');
    response
      .set({
        'Content-Type': 'image/jpeg',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(await readFile(join(this.directory, `${params.evidenceId}.jpg`)));
  }
}
