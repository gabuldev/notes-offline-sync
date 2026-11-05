import {
  Body,
  Controller,
  HttpCode,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { ReceiptLookupDto } from './dto/receipt-lookup.dto';
import { LookupResult, ReceiptLookupService } from './receipt-lookup.service';

@Controller('operations')
export class ReceiptLookupController {
  constructor(private readonly lookupService: ReceiptLookupService) {}

  @Post('lookup')
  @HttpCode(200)
  lookup(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    body: ReceiptLookupDto,
  ): { results: LookupResult[] } {
    return { results: this.lookupService.lookup(body.op_ids) };
  }
}
